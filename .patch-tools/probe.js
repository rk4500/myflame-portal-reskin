Java.perform(function () {
  console.log("probe: perform ran");
  var WebView = Java.use("android.webkit.WebView");
  console.log("probe: got WebView class");

  var found = false;
  var attempts = 0;
  var maxAttempts = 60; // ~120s at 2s interval

  function tryFind() {
    attempts++;
    Java.choose("android.webkit.WebView", {
      onMatch: function (instance) {
        found = true;
        console.log("probe: found WebView instance " + instance);
        var wv = instance;
        Java.scheduleOnMainThread(function () {
          try {
            wv.evaluateJavascript("document.body.style.background='red'; document.title;", null);
            console.log("probe: evaluateJavascript called OK on main thread");
          } catch (e) {
            console.log("probe: evaluateJavascript error on main thread: " + e);
          }
        });
      },
      onComplete: function () {
        if (!found) {
          console.log("probe: choose complete, no instance yet (attempt " + attempts + "/" + maxAttempts + ")");
          if (attempts < maxAttempts) {
            setTimeout(tryFind, 2000);
          } else {
            console.log("probe: giving up, no WebView instance ever appeared");
          }
        }
      }
    });
  }

  setTimeout(tryFind, 1000);
});
