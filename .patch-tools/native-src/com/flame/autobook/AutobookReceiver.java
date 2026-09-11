package com.flame.autobook;

// Real native background autobooking (native-autobook branch, 2026-09-11).
// Drives the same intents src/autobook.js manages in localStorage, from a
// real BroadcastReceiver woken by AlarmManager -- proven end to end this
// session (alarm survives the process being killed/swiped away, and an 8h
// idle gap, with a real Aura call succeeding against the bridged
// token/cookie; see HANDOFF.md, "Native background autobook"). This file
// replaces the earlier read-only plumbing test (fetchNextClass /
// getAllScheduledEvents) with the real thing: getReservations,
// getResourceAvailability, createReservation, ported from
// src/autobook.js's runAutoBook()/spawnNextOccurrence() to match behavior,
// not just shape.
//
// Auth (aura.context/aura.token/userId + session cookie) comes from
// SharedPreferences("flame_autobook"), bridged in by hook.src.js's
// bridgeAuthToPrefs() from the WebView's live auraState every page load --
// this receiver has no WebView and can't read localStorage itself. The
// waiting intents themselves are bridged the same way, by
// bridgeIntentsToPrefs() / window.__flameIntentsSnapshot().

import android.app.ActivityManager;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public class AutobookReceiver extends BroadcastReceiver {
  private static final String CHANNEL_ID = "flame_autobook";
  private static final int NOTIF_ID = 1002;
  private static final String PREFS = "flame_autobook";

  // Same number as src/autobook.js's BOOKING_WINDOW_MS -- the portal's real
  // 24h rule. No native-side early-margin: setExactAndAllowWhileIdle is
  // already precise to well within a second, and a real Aura call is
  // seconds at most (instant, a few seconds, or fails outright on no
  // network) -- nothing in that path benefits from a 30-minute head start.
  // The tight-retry burst right after opensAt already absorbs whatever
  // small clock skew there is, for free.
  private static final long BOOKING_WINDOW_MS = 24L * 60 * 60 * 1000;
  // Native-specific, deliberately bounded: JS's own 15s tightening runs for
  // as long as the app happens to stay open, which costs it nothing. A
  // native setExactAndAllowWhileIdle every 15s has a real battery/Doze
  // cost, so the tight burst is capped to the window HANDOFF documents
  // contested slots actually needing ("popular gym slots go within about
  // five minutes of opening") rather than held for the whole pre-slot wait.
  private static final long TIGHT_RETRY_MS = 20L * 1000;
  private static final long TIGHT_BURST_MS = 5L * 60 * 1000;
  // The middle of a 24h window is not contested -- a flat 2min cadence
  // there is ~720 wasted calls for one slot. Backs off exponentially
  // instead (2/4/8/16/32min, capped at MAX_RETRY_MS) starting right after
  // the opening burst ends, then tightens back up for the closing burst
  // below, since people cancel/no-show near their own deadline too.
  private static final long CALM_RETRY_MS = 2L * 60 * 1000;
  private static final long MAX_RETRY_MS = 60L * 60 * 1000;
  private static final long LATE_BURST_MS = 15L * 60 * 1000;
  private static final int SERIES_LOOKAHEAD_DAYS = 7;
  // Consecutive plain-exception failures on the same intent before
  // treating it as session-dead rather than just retrying -- see the
  // catch (Exception e) block in runOnce() for why this exists.
  private static final int FAIL_THRESHOLD = 3;

  private static final int REQUEST_CODE = 1002;

  @Override
  public void onReceive(Context context, Intent intent) {
    if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
      // setExactAndAllowWhileIdle doesn't survive a reboot -- this is the
      // only thing that re-arms it afterward. pending_intents itself
      // survives fine (real SharedPreferences, not tied to the alarm), so
      // this is pure reuse: scheduleNextWake() already no-ops correctly if
      // session_dead is set or nothing's waiting, same as any other call.
      scheduleNextWake(context.getApplicationContext());
      return;
    }

    ensureChannel(context);
    Context appContext = context.getApplicationContext();
    SharedPreferences prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE);

    if (prefs.getBoolean("session_dead", false)) {
      // Suspended: stop retrying until the app is reopened and re-bridges a
      // fresh token (hook.src.js clears this flag right after that happens).
      return;
    }

    final String auraContext = prefs.getString("aura_context", null);
    final String auraToken = prefs.getString("aura_token", null);
    final String userId = prefs.getString("aura_user_id", null);
    final String cookie = prefs.getString("cookie", null);
    if (auraContext == null || auraToken == null || userId == null) return;

    if (isForeground(appContext)) {
      // The JS-side loop (startAutoBookLoop, faster cadence) already covers
      // this pass and will paint the normal in-app banner itself -- stand
      // down rather than duplicate the Aura calls, but keep the alarm chain
      // alive for whenever the app isn't open to catch the next one.
      scheduleNextWake(appContext);
      return;
    }

    // Guards against two runOnce() passes overlapping -- a redelivered
    // BOOT_COMPLETED, or the alarm firing right as a previous run is still
    // finishing up, could otherwise have two background threads read the
    // same pending_intents, both attempt the same intent, and race on the
    // final prefs write (last write wins). Mirrors autoBookRunning's own
    // guard on the JS side. A BroadcastReceiver gets a fresh instance per
    // delivery, so this has to be static, not an instance field, and an
    // AtomicBoolean rather than a plain boolean so the check-and-set
    // itself can't itself race.
    if (!RUN_IN_PROGRESS.compareAndSet(false, true)) {
      return; // already running -- the in-flight pass (or the next alarm
               // fire once it's done) covers this
    }

    PendingResult result = goAsync();
    new Thread(new RunTask(appContext, auraContext, auraToken, userId, cookie, result)).start();
  }

  private static final AtomicBoolean RUN_IN_PROGRESS = new AtomicBoolean(false);

  private static class RunTask implements Runnable {
    private final Context appContext;
    private final String auraContext, auraToken, userId, cookie;
    private final PendingResult result;

    RunTask(Context appContext, String auraContext, String auraToken, String userId, String cookie, PendingResult result) {
      this.appContext = appContext;
      this.auraContext = auraContext;
      this.auraToken = auraToken;
      this.userId = userId;
      this.cookie = cookie;
      this.result = result;
    }

    @Override
    public void run() {
      try {
        runOnce(appContext, auraContext, auraToken, userId, cookie);
      } catch (Exception e) {
        // Any unexpected failure just means this pass produced nothing --
        // the alarm chain (armed inside runOnce before any of the risky
        // work, see below) keeps going regardless.
      } finally {
        RUN_IN_PROGRESS.set(false);
      }
      result.finish();
    }
  }

  // ---------------------------------------------------------------------
  // The run itself: mirrors runAutoBook() in src/autobook.js.
  // ---------------------------------------------------------------------

  private static void runOnce(Context appContext, String auraContext, String auraToken, String userId, String cookie) throws JSONException {
    SharedPreferences prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    JSONArray list = new JSONArray(prefs.getString("pending_intents", "[]"));
    int originalLen = list.length();
    if (originalLen == 0) {
      cancelAlarm(appContext);
      return;
    }

    Set<String> claimed = new HashSet<>();
    List<JSONObject> settled = new ArrayList<>();
    boolean changed = false;
    boolean sessionDead = false;
    long now = System.currentTimeMillis();

    for (int i = 0; i < originalLen; i++) {
      JSONObject intentObj = list.getJSONObject(i);
      if (!"waiting".equals(intentObj.optString("state"))) continue;

      String resourceName = intentObj.optString("resourceName");
      String date = intentObj.optString("date");
      String classKey = resourceClassKey(resourceName) + "|" + date;

      if (claimed.contains(classKey)) {
        intentObj.put("state", "failed");
        intentObj.put("message", "Only one " + cleanResourceName(resourceName) + " booking a day — another slot was already taken for " + date + ".");
        changed = true;
        settled.add(intentObj);
        continue;
      }

      Long start = slotStartMillis(date, intentObj.optString("startTime"));
      if (start == null) {
        intentObj.put("state", "failed");
        intentObj.put("message", "Could not read that slot time.");
        changed = true;
        settled.add(intentObj);
        continue;
      }
      long opensAt = start - BOOKING_WINDOW_MS;

      if (now >= start) {
        intentObj.put("state", "failed");
        intentObj.put("message", "The slot started before it could be booked.");
        spawnNextOccurrence(list, intentObj, now);
        changed = true;
        settled.add(intentObj);
        continue;
      }

      if (now < opensAt) continue; // not due yet, still waiting

      try {
        JSONArray reservations = getReservationsNative(userId, auraContext, auraToken, cookie);
        // A real round-trip just succeeded -- whatever session/network
        // trouble this intent was accumulating is clearly over.
        intentObj.put("nativeFailCount", 0);
        if (alreadyBookedThatDay(reservations, resourceName, date)) {
          claimed.add(classKey);
          intentObj.put("state", "failed");
          intentObj.put("message", "You already have a " + cleanResourceName(resourceName) + " booking that day.");
          spawnNextOccurrence(list, intentObj, now);
          changed = true;
          settled.add(intentObj);
          continue;
        }

        JSONArray slots = getAvailabilitySlots(intentObj.optString("resourceId"), date, auraContext, auraToken, cookie);
        JSONObject match = findSlotMatch(slots, intentObj.optString("startTime"));
        if (match == null || match.optInt("availableCapacity", 0) <= 0) {
          intentObj.put("message", match != null ? "Full — still watching." : "Not listed yet — still watching.");
          changed = true;
          continue; // stays waiting
        }

        String resultText = createReservationNative(intentObj, userId, auraContext, auraToken, cookie);
        String resultLower = resultText.toLowerCase(Locale.US);
        if (resultLower.matches(".*within\\s*1\\s*day.*")) {
          // The portal's own "too early" refusal -- confirmed live
          // (2026-09-11) against the JS side hitting this exact text from
          // the since-removed 30-min-early bug. Not terminal, stays
          // waiting: the window genuinely hasn't opened yet, same as a
          // plain "Full" response above.
          intentObj.put("message", "Not open yet — still watching.");
          changed = true;
          continue;
        }
        if (resultLower.contains("booking id")) {
          intentObj.put("state", "done");
          intentObj.put("message", resultText);
          claimed.add(classKey);
          spawnNextOccurrence(list, intentObj, now);
        } else {
          // createReservation answers refusals with state:SUCCESS and a
          // plain string too -- same quirk sendAura()/runAutoBook() handle.
          intentObj.put("state", "failed");
          intentObj.put("message", resultText);
          spawnNextOccurrence(list, intentObj, now);
        }
        changed = true;
        settled.add(intentObj);
      } catch (AuraInvalidTokenException tokenEx) {
        // No WebView here, no way to refresh a dead token -- stop
        // outright. Whatever settled earlier in this same pass is kept.
        sessionDead = true;
        break;
      } catch (Exception e) {
        // Not just a dead Aura token -- a session cookie can also expire
        // server-side (a login redirect / non-JSON page back instead of
        // the expected response), or the network can genuinely be down
        // for a long stretch. Neither throws AuraInvalidTokenException,
        // so without this an intent hit by either would retry forever,
        // silently, with no way to ever suspend or tell anyone. A run of
        // FAIL_THRESHOLD consecutive real exceptions on the *same* intent
        // (a clean "Full"/"not listed" response isn't one of these --
        // that's a successful round-trip with a disappointing answer, not
        // a failure) is treated exactly like a dead token: same suspend,
        // same "Autobook paused" notification, already generic enough
        // that it never claimed to be token-specific in the first place.
        int failCount = intentObj.optInt("nativeFailCount", 0) + 1;
        intentObj.put("nativeFailCount", failCount);
        intentObj.put("message", "Attempt failed: " + e.getMessage());
        changed = true; // stays waiting
        if (failCount >= FAIL_THRESHOLD) {
          sessionDead = true;
          break;
        }
      }
    }

    if (changed) {
      // pending_intents_result is the full list (including done/failed this
      // pass) for hook.src.js to fold into localStorage on next app open;
      // pending_intents is trimmed back to waiting-only, the same shape the
      // JS bridge itself always sends, so scheduleNextWake's next read
      // stays consistent regardless of which side last wrote it.
      JSONArray waitingOnly = new JSONArray();
      for (int i = 0; i < list.length(); i++) {
        JSONObject o = list.getJSONObject(i);
        if ("waiting".equals(o.optString("state"))) waitingOnly.put(o);
      }
      prefs.edit()
          .putString("pending_intents_result", list.toString())
          .putLong("native_updated_at", System.currentTimeMillis())
          .putString("pending_intents", waitingOnly.toString())
          .apply();
    }

    if (!settled.isEmpty()) notifySettled(appContext, settled);

    if (sessionDead) {
      int stillWaiting = 0;
      for (int i = 0; i < list.length(); i++) {
        if ("waiting".equals(list.optJSONObject(i).optString("state"))) stillWaiting++;
      }
      notifyAutobookPaused(appContext, stillWaiting);
      prefs.edit().putBoolean("session_dead", true).apply();
      cancelAlarm(appContext);
    } else {
      scheduleNextWake(appContext);
    }
  }

  // ---------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------

  // Doubling bands (2/4/8/16/32min, capped at MAX_RETRY_MS), computed fresh
  // from elapsed time rather than a persisted attempt counter -- keeps
  // scheduling a pure function of now/opensAt/start, same as everything
  // else here, with nothing extra to read or write per intent. Re-deriving
  // this on every call naturally reconstructs the right band as long as the
  // alarm actually fires close to when it was scheduled, which it does.
  private static long backoffInterval(long elapsedSincePostBurst) {
    long interval = CALM_RETRY_MS;
    long consumed = 0;
    while (consumed + interval <= elapsedSincePostBurst && interval < MAX_RETRY_MS) {
      consumed += interval;
      interval = Math.min(interval * 2, MAX_RETRY_MS);
    }
    return interval;
  }

  static void scheduleNextWake(Context appContext) {
    SharedPreferences prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    if (prefs.getBoolean("session_dead", false)) return; // stays suspended
    JSONArray list;
    try {
      list = new JSONArray(prefs.getString("pending_intents", "[]"));
    } catch (JSONException e) {
      list = new JSONArray();
    }
    if (list.length() == 0) {
      cancelAlarm(appContext);
      return;
    }

    long now = System.currentTimeMillis();
    long best = Long.MAX_VALUE;
    for (int i = 0; i < list.length(); i++) {
      JSONObject o = list.optJSONObject(i);
      if (o == null || !"waiting".equals(o.optString("state"))) continue;
      Long start = slotStartMillis(o.optString("date"), o.optString("startTime"));
      if (start == null) continue;
      long opensAt = start - BOOKING_WINDOW_MS;
      long candidate;
      if (now >= start) {
        candidate = now + 1000; // already past-due, catch it on the very next tick
      } else if (now >= start - LATE_BURST_MS) {
        // Closing rush: people cancel or no-show near their own deadline,
        // same reason the opening moment is contested.
        candidate = now + TIGHT_RETRY_MS;
      } else if (now >= opensAt + TIGHT_BURST_MS) {
        // The quiet middle of the window -- back off instead of a flat
        // 2min cadence for what can be most of 24h.
        candidate = now + backoffInterval(now - (opensAt + TIGHT_BURST_MS));
      } else if (now >= opensAt) {
        // The real contested rush (HANDOFF: popular gym slots go within
        // ~5 minutes of actually opening) -- anchored to the true opensAt,
        // not to opensAt-margin, or the burst would fully expire ~25min
        // before the slot really opens and leave the alarm on a calm
        // cadence for exactly the moment it matters most.
        candidate = now + TIGHT_RETRY_MS;
      } else {
        // No early margin: wake exactly at opensAt, not before. An exact
        // alarm is already precise well within a second, and the Aura call
        // itself is seconds at most -- nothing here benefits from starting
        // 30 minutes early, and the tight burst right after opensAt already
        // absorbs whatever small clock skew exists, for free.
        candidate = opensAt;
      }
      if (candidate < best) best = candidate;
    }
    if (best == Long.MAX_VALUE) {
      cancelAlarm(appContext);
      return;
    }

    AlarmManager am = (AlarmManager) appContext.getSystemService(Context.ALARM_SERVICE);
    PendingIntent pi = buildPendingIntent(appContext);
    boolean canExact = true;
    try {
      if (Build.VERSION.SDK_INT >= 31) canExact = am.canScheduleExactAlarms();
    } catch (Exception e) {}
    if (canExact) {
      am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, Math.max(best, now + 1000), pi);
    } else {
      am.set(AlarmManager.RTC_WAKEUP, Math.max(best, now + 1000), pi);
    }
  }

  private static void cancelAlarm(Context appContext) {
    AlarmManager am = (AlarmManager) appContext.getSystemService(Context.ALARM_SERVICE);
    am.cancel(buildPendingIntent(appContext));
  }

  private static PendingIntent buildPendingIntent(Context appContext) {
    Intent intent = new Intent(appContext, AutobookReceiver.class);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
    return PendingIntent.getBroadcast(appContext, REQUEST_CODE, intent, flags);
  }

  // Self-inspection only (this app's own process importance) -- needs no
  // extra permission; PACKAGE_USAGE_STATS is only required to query OTHER
  // apps' processes.
  private static boolean isForeground(Context appContext) {
    try {
      ActivityManager am = (ActivityManager) appContext.getSystemService(Context.ACTIVITY_SERVICE);
      List<ActivityManager.RunningAppProcessInfo> procs = am.getRunningAppProcesses();
      if (procs == null) return false;
      String pkg = appContext.getPackageName();
      for (ActivityManager.RunningAppProcessInfo p : procs) {
        if (pkg.equals(p.processName)) {
          return p.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
        }
      }
    } catch (Exception e) {}
    return false;
  }

  // ---------------------------------------------------------------------
  // Daily-repeat spawning -- port of spawnNextOccurrence()/conflictingIntent()
  // in src/autobook.js. Needed so a daily series keeps advancing while the
  // app stays closed, which is the actual point of this feature.
  // ---------------------------------------------------------------------

  private static boolean conflictingIntent(JSONArray list, String resourceName, String isoDate) {
    String key = resourceClassKey(resourceName);
    for (int i = 0; i < list.length(); i++) {
      JSONObject o = list.optJSONObject(i);
      if (o == null || !"waiting".equals(o.optString("state"))) continue;
      if (!resourceClassKey(o.optString("resourceName")).equals(key)) continue;
      String d = o.optString("date");
      if (d.equals(isoDate)) return true;
      if ("daily".equals(o.optString("repeat")) && d.compareTo(isoDate) < 0) return true;
    }
    return false;
  }

  private static void spawnNextOccurrence(JSONArray list, JSONObject intentObj, long now) throws JSONException {
    if (!"daily".equals(intentObj.optString("repeat"))) return;
    Long start = slotStartMillis(intentObj.optString("date"), intentObj.optString("startTime"));
    if (start == null) return;
    LocalDate base = LocalDate.ofInstant(Instant.ofEpochMilli(start), ZoneId.systemDefault());
    for (int ahead = 1; ahead <= SERIES_LOOKAHEAD_DAYS; ahead++) {
      String nextDate = base.plusDays(ahead).toString();
      if (conflictingIntent(list, intentObj.optString("resourceName"), nextDate)) continue;
      JSONObject next = new JSONObject(intentObj.toString()); // clone
      next.put("id", "n" + now + "_" + ahead);
      next.put("date", nextDate);
      next.put("state", "waiting");
      next.put("message", "");
      next.put("createdAt", now);
      list.put(next);
      return;
    }
  }

  // ---------------------------------------------------------------------
  // Aura calls
  // ---------------------------------------------------------------------

  private static class AuraInvalidTokenException extends Exception {
    AuraInvalidTokenException(String msg) { super(msg); }
  }

  // Returns the unwrapped `action` object (action.returnValue.* still to be
  // read by the caller, since its shape differs per method -- an array for
  // getReservations, a string for getResourceAvailability/createReservation).
  private static JSONObject auraCall(String classname, String method, JSONObject params, String auraContext, String auraToken, String cookie) throws Exception {
    JSONObject innerParams = new JSONObject();
    innerParams.put("namespace", "");
    innerParams.put("classname", classname);
    innerParams.put("method", method);
    innerParams.put("cacheable", false);
    innerParams.put("isContinuation", false);
    if (params != null) innerParams.put("params", params);

    JSONObject action = new JSONObject();
    action.put("id", "0");
    action.put("descriptor", "aura://ApexActionController/ACTION$execute");
    action.put("callingDescriptor", "UNKNOWN");
    action.put("params", innerParams);

    JSONObject message = new JSONObject();
    message.put("actions", new JSONArray().put(action));

    String body = "message=" + URLEncoder.encode(message.toString(), "UTF-8")
        + "&aura.context=" + URLEncoder.encode(auraContext, "UTF-8")
        + "&aura.token=" + URLEncoder.encode(auraToken, "UTF-8")
        + "&aura.pageURI=" + URLEncoder.encode("/s/", "UTF-8");

    URL url = new URL("https://my.flame.edu.in/s/sfsites/aura?r=" + System.currentTimeMillis() + "&aura.ApexAction.execute=1");
    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
    try {
      conn.setRequestMethod("POST");
      conn.setDoOutput(true);
      conn.setConnectTimeout(8000);
      conn.setReadTimeout(8000);
      conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
      if (cookie != null) conn.setRequestProperty("Cookie", cookie);

      OutputStream os = conn.getOutputStream();
      os.write(body.getBytes("UTF-8"));
      os.close();

      int code = conn.getResponseCode();
      InputStream is = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
      String responseStr = readAll(is);
      if (code < 200 || code >= 300) throw new Exception("HTTP " + code + ": " + responseStr);

      JSONObject json = new JSONObject(responseStr);
      JSONArray actions = json.optJSONArray("actions");
      if (actions == null || actions.length() == 0) throw new Exception("no response from portal");
      JSONObject act = actions.getJSONObject(0);
      if (!"SUCCESS".equals(act.optString("state"))) {
        if (responseStr.contains("INVALID_TOKEN")) throw new AuraInvalidTokenException("token rejected");
        throw new Exception(classname + "." + method + " failed: " + act.opt("error"));
      }
      return act;
    } finally {
      conn.disconnect();
    }
  }

  private static JSONArray getReservationsNative(String userId, String context, String token, String cookie) throws Exception {
    JSONObject params = new JSONObject().put("userId", userId);
    JSONObject act = auraCall("CustomBookingController", "getReservations", params, context, token, cookie);
    return act.getJSONObject("returnValue").getJSONArray("returnValue");
  }

  // Outer returnValue is a plain string; on real availability it's itself
  // JSON ({"resourceId":...,"availabilitySlots":[...]}), on "no slots"/an
  // out-of-window date it's just a prose sentence ("No slot available.") --
  // confirmed against aura_map.md's captured shapes, not assumed.
  private static JSONArray getAvailabilitySlots(String resourceId, String bookingDate, String context, String token, String cookie) throws Exception {
    JSONObject params = new JSONObject().put("resourceId", resourceId).put("bookingDate", bookingDate);
    JSONObject act = auraCall("CustomBookingController", "getResourceAvailability", params, context, token, cookie);
    String raw = act.getJSONObject("returnValue").getString("returnValue");
    try {
      return new JSONObject(raw).getJSONArray("availabilitySlots");
    } catch (JSONException e) {
      return new JSONArray();
    }
  }

  private static String createReservationNative(JSONObject intentObj, String userId, String context, String token, String cookie) throws Exception {
    JSONObject params = new JSONObject();
    params.put("userId", userId);
    params.put("resource", intentObj.optString("resourceId"));
    params.put("startTime", intentObj.optString("startTime"));
    params.put("endTime", intentObj.optString("endTime"));
    params.put("dateSelected", intentObj.optString("date"));
    params.put("bookingPurpose", intentObj.optString("purpose", ""));
    params.put("coAttendee", intentObj.optString("coAttendee", ""));
    JSONObject act = auraCall("CustomBookingController", "createReservation", params, context, token, cookie);
    return act.getJSONObject("returnValue").getString("returnValue");
  }

  private static boolean alreadyBookedThatDay(JSONArray reservations, String resourceName, String isoDate) {
    String wanted = resourceClassKey(resourceName);
    for (int i = 0; i < reservations.length(); i++) {
      JSONObject b = reservations.optJSONObject(i);
      if (b == null) continue;
      if (!"Booked".equals(b.optString("status"))) continue;
      if (!resourceClassKey(b.optString("resourceName")).equals(wanted)) continue;
      Long when = parseBookingDateTimeMillis(b.optString("startDateTime"));
      if (when == null) continue;
      String day = LocalDate.ofInstant(Instant.ofEpochMilli(when), ZoneId.systemDefault()).toString();
      if (day.equals(isoDate)) return true;
    }
    return false;
  }

  private static JSONObject findSlotMatch(JSONArray slots, String wantedStartTime) {
    Integer wanted = parseClockMinutes(wantedStartTime);
    if (wanted == null) return null;
    for (int i = 0; i < slots.length(); i++) {
      JSONObject s = slots.optJSONObject(i);
      if (s == null) continue;
      Integer m = parseClockMinutes(s.optString("startTime"));
      if (m != null && m.equals(wanted)) return s;
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Date/text helpers -- ports of src/autobook.js and src/dates.js.
  // ---------------------------------------------------------------------

  private static final Pattern CLOCK_RE = Pattern.compile("^(\\d{1,2})(?::(\\d{2}))?\\s*([ap])\\.?m\\.?$", Pattern.CASE_INSENSITIVE);

  // Port of parseClockMinutes() in src/autobook.js.
  private static Integer parseClockMinutes(String text) {
    if (text == null) return null;
    Matcher m = CLOCK_RE.matcher(text.trim());
    if (!m.matches()) return null;
    int hour12 = Integer.parseInt(m.group(1)) % 12;
    boolean pm = m.group(3).equalsIgnoreCase("p");
    int hour = pm ? hour12 + 12 : hour12;
    int mins = m.group(2) != null ? Integer.parseInt(m.group(2)) : 0;
    return hour * 60 + mins;
  }

  // Port of slotStartDate() in src/autobook.js -- isoDate ("YYYY-MM-DD") +
  // a portal clock string ("6:00 AM"), read as local time.
  private static Long slotStartMillis(String isoDate, String clockStr) {
    Integer mins = parseClockMinutes(clockStr);
    if (mins == null || isoDate == null || isoDate.isEmpty()) return null;
    try {
      LocalDate d = LocalDate.parse(isoDate);
      LocalDateTime dt = d.atTime(mins / 60, mins % 60);
      return dt.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli();
    } catch (Exception e) {
      return null;
    }
  }

  // Port of parseBookingDateTime() in src/dates.js -- "DD/MM/YYYY, h:mm AM".
  private static Long parseBookingDateTimeMillis(String s) {
    if (s == null) return null;
    String[] parts = s.split(", ", 2);
    if (parts.length != 2) return null;
    String[] dmy = parts[0].split("/");
    if (dmy.length != 3) return null;
    Integer mins = parseClockMinutes(parts[1]);
    if (mins == null) return null;
    try {
      int day = Integer.parseInt(dmy[0]);
      int month = Integer.parseInt(dmy[1]);
      int year = Integer.parseInt(dmy[2]);
      LocalDateTime dt = LocalDate.of(year, month, day).atTime(mins / 60, mins % 60);
      return dt.atZone(ZoneId.systemDefault()).toInstant().toEpochMilli();
    } catch (Exception e) {
      return null;
    }
  }

  // Port of cleanResourceName()/resourceClassKey() in src/dates.js and
  // src/autobook.js -- strips the trailing operating-window parenthetical
  // ("Gym ( 6:00 am to 2:00 pm slot )" -> "Gym") so the 6 AM and 3 PM gym
  // compare as the same class, matching the portal's own one-a-day rule.
  private static final Pattern TRAILING_PAREN_RE = Pattern.compile("\\s*\\([^)]*\\)\\s*$");

  private static String cleanResourceName(String name) {
    if (name == null) return "";
    return TRAILING_PAREN_RE.matcher(name).replaceAll("").trim();
  }

  private static String resourceClassKey(String name) {
    return cleanResourceName(name).toLowerCase(Locale.US);
  }

  private static String readAll(InputStream is) throws Exception {
    if (is == null) return "";
    BufferedReader reader = new BufferedReader(new InputStreamReader(is, "UTF-8"));
    StringBuilder sb = new StringBuilder();
    String line;
    while ((line = reader.readLine()) != null) sb.append(line);
    reader.close();
    return sb.toString();
  }

  // ---------------------------------------------------------------------
  // Notification
  // ---------------------------------------------------------------------

  private static void ensureChannel(Context context) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
      if (nm.getNotificationChannel(CHANNEL_ID) == null) {
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID, "Autobook results", NotificationManager.IMPORTANCE_HIGH);
        nm.createNotificationChannel(channel);
      }
    }
  }

  // The portal's own booking-id shape, confirmed against aura_map.md
  // ("Booking Id R-714794" in createReservation's success prose, "R-714864"
  // etc. in getReservations' bookingId field) -- pulled out so the
  // notification can show a real reference number instead of just "Booked",
  // matching how the in-app UI treats a booking id as the actual signal of
  // success (see runOnce()'s own .contains("booking id") check).
  private static final Pattern BOOKING_ID_RE = Pattern.compile("(R-\\d+)");

  // Ports of shortDayLabel()/compactTimeRange() in src/dates.js -- same
  // "Today"/"Tomorrow"/"Fri, Sep 12" and "4 – 5 PM" (on-the-hour :00
  // dropped) the rest of the app already shows, rather than a raw
  // "2026-09-12, 4:00 PM–5:00 PM" the notification alone would otherwise be
  // the one place in this whole app to still show.
  private static String shortDayLabel(LocalDate date) {
    long diff = ChronoUnit.DAYS.between(LocalDate.now(ZoneId.systemDefault()), date);
    if (diff == 0) return "Today";
    if (diff == 1) return "Tomorrow";
    return date.format(DateTimeFormatter.ofPattern("EEE, MMM d", Locale.US));
  }

  private static final Pattern ZERO_MINUTES_RE = Pattern.compile("^(\\d{1,2}):00(?=\\s*[APap]|$)");

  private static String compactTimeRange(String startStr, String endStr) {
    String start = ZERO_MINUTES_RE.matcher(startStr == null ? "" : startStr.trim()).replaceFirst("$1");
    String end = ZERO_MINUTES_RE.matcher(endStr == null ? "" : endStr.trim()).replaceFirst("$1");
    return start + " – " + end;
  }

  // Every distinct way an intent can settle, from runOnce() above:
  //   done   -- real success, message is the portal's own confirmation prose
  //   failed -- one of: a same-day claim conflict, an unparseable slot time,
  //             the slot's own start time passing before it could be tried,
  //             an existing booking already covering that day/class, or a
  //             genuine portal refusal (its own prose, e.g. "More than 1
  //             bookings are not allowed..."). All five already set a clear,
  //             specific intent.message at the point of failure -- shown
  //             verbatim rather than collapsed into one generic line, same
  //             "never swallow the tap, say why" rule the in-app UI follows.
  private static String settledHeader(JSONObject intentObj) {
    boolean done = "done".equals(intentObj.optString("state"));
    return (done ? "Booked " : "Couldn't book ") + cleanResourceName(intentObj.optString("resourceName"));
  }

  private static String settledDetail(JSONObject intentObj) {
    String when;
    try {
      when = shortDayLabel(LocalDate.parse(intentObj.optString("date")));
    } catch (Exception e) {
      when = intentObj.optString("date"); // unparseable date already means "Could not read that slot time" is the real message below
    }
    when += " · " + compactTimeRange(intentObj.optString("startTime"), intentObj.optString("endTime"));

    if ("done".equals(intentObj.optString("state"))) {
      Matcher m = BOOKING_ID_RE.matcher(intentObj.optString("message"));
      return when + (m.find() ? "  (" + m.group(1) + ")" : "");
    }
    return when + "\n" + intentObj.optString("message");
  }

  private static void notifySettled(Context context, List<JSONObject> settled) {
    String title;
    String body;
    if (settled.size() == 1) {
      title = settledHeader(settled.get(0));
      body = settledDetail(settled.get(0));
    } else {
      title = "Autobook results";
      StringBuilder sb = new StringBuilder();
      for (JSONObject intentObj : settled) {
        sb.append(settledHeader(intentObj)).append('\n').append(settledDetail(intentObj)).append("\n\n");
      }
      body = sb.toString().trim();
    }

    NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
    Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        ? new Notification.Builder(context, CHANNEL_ID)
        : new Notification.Builder(context);
    builder.setContentTitle(title)
        .setContentText(body)
        .setSmallIcon(android.R.drawable.ic_menu_month)
        .setAutoCancel(true)
        .setPriority(Notification.PRIORITY_HIGH)
        .setStyle(new Notification.BigTextStyle().bigText(body));
    PendingIntent contentIntent = buildOpenTabIntent(context, "bookings");
    if (contentIntent != null) builder.setContentIntent(contentIntent);
    nm.notify(NOTIF_ID, builder.build());
  }

  // Every notification here is about a booking/watch, so every one taps
  // through to My Bookings specifically, not just a generic app-open --
  // the extra rides on the launch Intent (flame_open_tab), read back by
  // hook.src.js's onPageFinished handler and handed to shell.js's boot
  // call the same way ?tab= already steers the local preview harness.
  // Only reliably reaches shell.js on a genuine cold start (the launch
  // Intent's extra) -- tapping while the app's task is already alive
  // depends on whether RN's own Activity base class re-delivers it via
  // onNewIntent()/setIntent(), unconfirmed either way; the realistic case
  // this matters for is the background-alarm notification, which by
  // definition only ever fires while the app isn't already open.
  private static PendingIntent buildOpenTabIntent(Context context, String tab) {
    Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
    if (launch == null) return null;
    launch.putExtra("flame_open_tab", tab);
    return PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  // Covers two triggers now, both treated identically: a dead Aura token
  // (AuraInvalidTokenException) and FAIL_THRESHOLD consecutive plain
  // exceptions on the same intent (a dead session cookie, a login
  // redirect instead of JSON, or the network genuinely being down for a
  // long stretch -- none of which throw AuraInvalidTokenException, so
  // without the fail-count check they'd retry forever, silently). Neither
  // is a per-intent settle -- both suspend the whole chain (see runOnce())
  // until the app is reopened, and previously only the token case ever
  // told anyone autobooking had stopped at all. One notification per
  // suspension (this only runs the moment sessionDead actually flips
  // true; the alarm is cancelled right after, so there's nothing to
  // re-fire this from until a fresh app open re-arms it).
  private static final int TOKEN_DEAD_NOTIF_ID = 1004;

  private static void notifyAutobookPaused(Context context, int stillWaiting) {
    ensureChannel(context);
    String body = stillWaiting == 1
        ? "Couldn't reach the portal — 1 watch is paused. Open the app to resume it."
        : "Couldn't reach the portal — " + stillWaiting + " watches are paused. Open the app to resume them.";

    NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
    Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        ? new Notification.Builder(context, CHANNEL_ID)
        : new Notification.Builder(context);
    builder.setContentTitle("Autobook paused")
        .setContentText(body)
        .setSmallIcon(android.R.drawable.ic_menu_month)
        .setAutoCancel(true)
        .setPriority(Notification.PRIORITY_HIGH)
        .setStyle(new Notification.BigTextStyle().bigText(body));
    PendingIntent contentIntent = buildOpenTabIntent(context, "bookings");
    if (contentIntent != null) builder.setContentIntent(contentIntent);
    nm.notify(TOKEN_DEAD_NOTIF_ID, builder.build());
  }

  // Called from hook.src.js's title-hook signal handler -- these are the
  // real, nicely-formatted notifications, fired for a booking/cancel made
  // from *inside* the app (JS-driven, via the title-hook signal), not just
  // the background alarm path above. Public/JSON-string entry points
  // because that's what's reachable from Frida's Java bridge cleanly (see
  // the CharSequence overload trap noted elsewhere in this file) -- real
  // parsing happens here in compiled Java, not over the bridge.

  public static void notifySettledFromJson(Context context, String intentsJson) {
    try {
      JSONArray arr = new JSONArray(intentsJson);
      List<JSONObject> settled = new ArrayList<>();
      for (int i = 0; i < arr.length(); i++) settled.add(arr.getJSONObject(i));
      if (!settled.isEmpty()) notifySettled(context, settled);
    } catch (JSONException e) {}
  }

  public static void notifyCancelledFromJson(Context context, String intentJson) {
    try {
      notifyCancelled(context, new JSONObject(intentJson));
    } catch (JSONException e) {}
  }

  public static void notifyScheduledFromJson(Context context, String intentJson) {
    try {
      notifyScheduled(context, new JSONObject(intentJson));
    } catch (JSONException e) {}
  }

  // Same "Autobook · <name>" language the in-app row/confirm already use
  // (pendingIntentText()/attachCancelConfirm in src/autobook.js -- the row
  // reads "Autobook · Gym", the confirm asks "Cancel Autobook · Gym?"), not
  // invented notification-only wording.
  private static void notifyCancelled(Context context, JSONObject intentObj) {
    postSimpleNotification(context, CANCELLED_NOTIF_ID,
        "Cancelled Autobook · " + cleanResourceName(intentObj.optString("resourceName")), intentObj);
  }

  private static void notifyScheduled(Context context, JSONObject intentObj) {
    String title = "Autobook · " + cleanResourceName(intentObj.optString("resourceName"))
        + ("daily".equals(intentObj.optString("repeat")) ? " (daily)" : "");
    postSimpleNotification(context, SCHEDULED_NOTIF_ID, title, intentObj);
  }

  // Shared by the two lifecycle notifications above (scheduled/cancelled) --
  // just a "when" line, no settle message to show.
  private static void postSimpleNotification(Context context, int notifId, String title, JSONObject intentObj) {
    ensureChannel(context);
    String body;
    try {
      body = shortDayLabel(LocalDate.parse(intentObj.optString("date")))
          + " · " + compactTimeRange(intentObj.optString("startTime"), intentObj.optString("endTime"));
    } catch (Exception e) {
      body = intentObj.optString("date");
    }

    NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
    Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        ? new Notification.Builder(context, CHANNEL_ID)
        : new Notification.Builder(context);
    builder.setContentTitle(title)
        .setContentText(body)
        .setSmallIcon(android.R.drawable.ic_menu_month)
        .setAutoCancel(true)
        .setPriority(Notification.PRIORITY_DEFAULT);
    PendingIntent contentIntent = buildOpenTabIntent(context, "bookings");
    if (contentIntent != null) builder.setContentIntent(contentIntent);
    nm.notify(notifId, builder.build());
  }

  private static final int CANCELLED_NOTIF_ID = 1005;
  private static final int SCHEDULED_NOTIF_ID = 1006;
}
