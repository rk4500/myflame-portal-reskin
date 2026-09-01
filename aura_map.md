# Aura descriptor map

Parsed 8 HAR entries, 1 unique descriptors, 1 skipped (no message), merged with 29 sample(s) from prior aura_map.json.

## `aura://ApexActionController/ACTION$execute`

seen 32 distinct call(s)

**call 1** — page: `https://my.flame.edu.in/s/calendar`, state: `SUCCESS`

params:
```json
{
  "namespace": "",
  "classname": "AiAssistantFlameCommunityWrapper",
  "method": "getAssistantName",
  "cacheable": true,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": "Gyan",
  "cacheable": true
}
```

**call 2** — page: `https://my.flame.edu.in/s/calendar`, state: `SUCCESS`

params:
```json
{
  "namespace": "",
  "classname": "AiAssistantFlameCommunityWrapper",
  "method": "getAssistantContext",
  "cacheable": true,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": {
    "additionalKnowledgeFileIds": [
      "file-XqT2vLZpHfPJFbCsErDtcE"
    ],
    "threadContext": "Rudra Krishna (Roll Number: 240578) from Undergraduate Program (UGLE) 2024 is starting the conversation.The user's date time is 2026-09-01 00:00:39. The Salesforce user record Id is 0055i00000CwfKqAAJ."
  },
  "cacheable": true
}
```

**call 3** — page: `https://my.flame.edu.in/s/calendar`, state: `SUCCESS`

params:
```json
{
  "namespace": "",
  "classname": "NavigationMenuCtrl",
  "method": "checkViewMinutesAccess",
  "cacheable": true,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": false,
  "cacheable": true
}
```

**call 4** — page: `https://my.flame.edu.in/s/calendar`, state: `SUCCESS`

params:
```json
{
  "namespace": "",
  "classname": "NavigationMenuCtrl",
  "method": "getUserContactDetails",
  "cacheable": true,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": {
    "classificationVisitingFaculty": false,
    "contactRecordTypeName": "FU-Student",
    "primaryContactType": "Student",
    "profileName": "Student",
    "profilePhotoUrl": "data:image/jpeg;base64,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
... (truncated, see .json for full)
```

**call 5** — page: `https://my.flame.edu.in/s/calendar`, state: `SUCCESS`

params:
```json
{
  "namespace": "",
  "classname": "NavigationMenuItemsController",
  "method": "getSecurityMenuItems",
  "cacheable": false,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": [],
  "cacheable": true
}
```

**call 6** — page: `https://my.flame.edu.in/s/calendar`, state: `ERROR`

params:
```json
{
  "namespace": "",
  "classname": "NavigationMenuItemsController",
  "method": "getNavigationMenuItems",
  "params": {
    "navigationLinkSetMasterLabel": "",
    "publishStatus": "Live",
    "addHomeMenuItem": true,
    "includeImageUrl": false
  },
  "cacheable": false,
  "isContinuation": false
}
```

returnValue:
```json
{
  "cacheable": true
}
```

error: `[{'exceptionType': 'ConnectApi.ConnectApiException', 'isUserDefinedException': True, 'message': 'Specify a valid "navigationLinkSetDeveloperName".', 'stackTrace': '(System Code)\nClass.NavigationMenuItemsController.getNavigationMenuItems: line 92, column 1'}]`

**call 7** — page: `https://my.flame.edu.in/s/`, state: `ERROR`

params:
```json
{
  "namespace": "",
  "classname": "EntryExitHeaderController",
  "method": "getHeaderUser",
  "cacheable": false,
  "isContinuation": false
}
```

returnValue:
```json
{
  "cacheable": true
}
```

error: `[{'message': "You do not have access to the Apex class named 'EntryExitHeaderController'."}]`

**call 8** — page: `https://my.flame.edu.in/s/calendar`, state: `ERROR`

params:
```json
{
  "namespace": "",
  "classname": "NavigationMenuItemsController",
  "method": "getNavigationMenuItems",
  "params": {
    "navigationLinkSetMasterLabel": "",
    "publishStatus": "Live",
    "addHomeMenuItem": true,
    "includeImageUrl": false
  },
  "cacheable": true,
  "isContinuation": false
}
```

returnValue:
```json
{
  "cacheable": true
}
```

error: `[{'exceptionType': 'ConnectApi.ConnectApiException', 'isUserDefinedException': True, 'message': 'Specify a valid "navigationLinkSetDeveloperName".', 'stackTrace': '(System Code)\nClass.NavigationMenuItemsController.getNavigationMenuItems: line 92, column 1'}]`

**call 9** — page: `https://my.flame.edu.in/s/calendar`, state: `SUCCESS`

params:
```json
{
  "namespace": "",
  "classname": "NavigationMenuItemsController",
  "method": "getNavigationMenuItems",
  "params": {
    "navigationLinkSetMasterLabel": "Student Navigation",
    "publishStatus": "Live",
    "addHomeMenuItem": true,
    "includeImageUrl": false
  },
  "cacheable": false,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": [
    {
      "actionType": "InternalLink",
      "actionValue": "/s/",
      "imageUrl": null,
      "label": "Home",
      "subMenu": [],
      "target": "CurrentWindow"
    },
    {
      "actionType": "InternalLink",
      "actionValue": null,
      "imageUrl": null,
      "label": "Academics",
      "subMenu": [
        {
          "actionType": "InternalLink",
          "actionValue": "/s/my-programs",
          "imageUrl": null,
          "label": "My Programs",
          "subMenu": [],
          "target": "CurrentWindow"
        },
        {
          "actionType": "InternalLink",
          "actionValue": "/s/calendar",
          "imageUrl": null,
          "label": "Calendar",
          "subMenu": [],
          "target": "CurrentWindow"
        },
        {
          "actionType": "InternalLink",
          "actionValue": "/s/attendance",
          "imageUrl": null,
          "label": "Attendance",
          "subMenu": [],
          "target": "CurrentWindow"
        },
        {
          "actionType": "ExternalLink",
          "actionValue": "https://lms.flame.edu.in/login/index.php",
          "imageUrl": null,
          "label": "LMS",
          "subMenu": [],
          "target": "NewWindow"
        },
        {
          "actionType": "ExternalLink",
          "actionValue": "https://flame.my.site.com/coursecatalogue/s/login/",
          "imageUrl": null,
          "label": "Catalogue",
          "subMenu": [],
          "target": "NewWindow"
        },
        {
          "actionType": "ExternalLink",
          "actionValue": "https://library.flame.edu.in/user#/home",
          "imageUrl": null,
          "label": "Library",
          "subMenu": [],
          "target": "NewWindow"
        },
        {
          "actionType": "InternalLink",
          "actionValue": "/s/examination",
          "imageUrl": null,
          "label": "Examination",
          "subMenu": [],
          "target": "CurrentWindow"
        }
      ],
      "target": "CurrentWindow"
    },
    {
      "actionType": "ExternalLink",
      "actionValue": "https://housing.flame.edu.in/current-batch",
      "imageUrl": null,
      "label": "MyResidence",
      "subMenu": [],
      "target": "CurrentWindow"
    },
    {
      "actionType": "InternalLink",
      "actionValue": null,
      "imageUrl": null,
      "label": "Bookings",
      "subMenu": [
        {
          "actionType": "InternalLink",
          "actionValue": "/s/book-slot",
          "imageUrl": null,
          "label": "Book Slot",
          "subMenu": [],
          "target": "CurrentWindow"
        },
        {
          "actionType": "InternalLink",
          "actionValue": "/s/my-booking",
          "imageUrl": null,
          "label": "My Bookings",
          "subMenu": [],
          "target": "CurrentWindow"
        }
      ],
      "target": "CurrentWindow"
    },
    {
      "actionType": "InternalLink",
      "actionValue": "/s/resources",
      "imageUrl": null,
      "label
... (truncated, see .json for full)
```

**call 10** — page: `https://my.flame.edu.in/s/calendar`, state: `SUCCESS`

params:
```json
{
  "namespace": "",
  "classname": "NavigationMenuItemsController",
  "method": "getNavigationMenuItems",
  "params": {
    "navigationLinkSetMasterLabel": "Student Navigation",
    "publishStatus": "Live",
    "addHomeMenuItem": true,
    "includeImageUrl": false
  },
  "cacheable": true,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": [
    {
      "actionType": "InternalLink",
      "actionValue": "/s/",
      "imageUrl": null,
      "label": "Home",
      "subMenu": [],
      "target": "CurrentWindow"
    },
    {
      "actionType": "InternalLink",
      "actionValue": null,
      "imageUrl": null,
      "label": "Academics",
      "subMenu": [
        {
          "actionType": "InternalLink",
          "actionValue": "/s/my-programs",
          "imageUrl": null,
          "label": "My Programs",
          "subMenu": [],
          "target": "CurrentWindow"
        },
        {
          "actionType": "InternalLink",
          "actionValue": "/s/calendar",
          "imageUrl": null,
          "label": "Calendar",
          "subMenu": [],
          "target": "CurrentWindow"
        },
        {
          "actionType": "InternalLink",
          "actionValue": "/s/attendance",
          "imageUrl": null,
          "label": "Attendance",
          "subMenu": [],
          "target": "CurrentWindow"
        },
        {
          "actionType": "ExternalLink",
          "actionValue": "https://lms.flame.edu.in/login/index.php",
          "imageUrl": null,
          "label": "LMS",
          "subMenu": [],
          "target": "NewWindow"
        },
        {
          "actionType": "ExternalLink",
          "actionValue": "https://flame.my.site.com/coursecatalogue/s/login/",
          "imageUrl": null,
          "label": "Catalogue",
          "subMenu": [],
          "target": "NewWindow"
        },
        {
          "actionType": "ExternalLink",
          "actionValue": "https://library.flame.edu.in/user#/home",
          "imageUrl": null,
          "label": "Library",
          "subMenu": [],
          "target": "NewWindow"
        },
        {
          "actionType": "InternalLink",
          "actionValue": "/s/examination",
          "imageUrl": null,
          "label": "Examination",
          "subMenu": [],
          "target": "CurrentWindow"
        }
      ],
      "target": "CurrentWindow"
    },
    {
      "actionType": "ExternalLink",
      "actionValue": "https://housing.flame.edu.in/current-batch",
      "imageUrl": null,
      "label": "MyResidence",
      "subMenu": [],
      "target": "CurrentWindow"
    },
    {
      "actionType": "InternalLink",
      "actionValue": null,
      "imageUrl": null,
      "label": "Bookings",
      "subMenu": [
        {
          "actionType": "InternalLink",
          "actionValue": "/s/book-slot",
          "imageUrl": null,
          "label": "Book Slot",
          "subMenu": [],
          "target": "CurrentWindow"
        },
        {
          "actionType": "InternalLink",
          "actionValue": "/s/my-booking",
          "imageUrl": null,
          "label": "My Bookings",
          "subMenu": [],
          "target": "CurrentWindow"
        }
      ],
      "target": "CurrentWindow"
    },
    {
      "actionType": "InternalLink",
      "actionValue": "/s/resources",
      "imageUrl": null,
      "label
... (truncated, see .json for full)
```

**call 11** — page: `https://my.flame.edu.in/s/`, state: `SUCCESS`

params:
```json
{
  "namespace": "notifbell",
  "classname": "NotificationsTrayController",
  "method": "getNotifications",
  "params": {
    "numDays": null,
    "maxNumNotifications": 50
  },
  "cacheable": false,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": {
    "mostRecentNotifications": []
  },
  "cacheable": false
}
```

**call 12** — page: `https://my.flame.edu.in/s/calendar`, state: `SUCCESS`

params:
```json
{
  "namespace": "",
  "classname": "StudentPortalCalendarCtrl",
  "method": "getAllScheduledEvents",
  "params": {
    "userId": "0055i00000CwfKqAAJ"
  },
  "cacheable": false,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": [
    {
      "courseName": "Communication Theory",
      "endDateTime": "2025-03-18T10:55:00",
      "faculty": "Dipannita Das",
      "facultySalutation": "Prof.",
      "id": "a8HJ3000000PQYlMAO",
      "room": "APJ Abdul Kalam  007",
      "sessionTime": "10:00 - 10:55",
      "startDateTime": "2025-03-18T10:00:00",
      "title": "COMS101_UGTERM4B"
    },
    {
      "courseName": "Programming in C++ with Lab",
      "endDateTime": "2025-10-08T16:10:00",
      "faculty": "Rahul Kumar Ray",
      "facultySalutation": "Prof.",
      "id": "a8HJ3000000PeZQMA0",
      "room": "Tagore 002",
      "sessionTime": "15:15 - 16:10",
      "startDateTime": "2025-10-08T15:15:00",
      "title": "CSIT211_UGSEM3A"
    },
    {
      "courseName": "Introduction to Programming",
      "endDateTime": "2024-08-23T11:55:00",
      "id": "a8HJ3000000PGquMAG",
      "room": "APJ Abdul Kalam 105",
      "sessionTime": "11:00 - 11:55",
      "startDateTime": "2024-08-23T11:00:00",
      "title": "CSIT101_UGTERM1"
    },
    {
      "courseName": "Design and Analysis of Algorithms",
      "endDateTime": "2026-11-19T18:10:00",
      "faculty": "Lokendra Vishwakarma",
      "facultySalutation": "Prof.",
      "id": "a8Hfv000000AESREA4",
      "room": "Library Computer Lab",
      "sessionTime": "17:15 - 18:10",
      "startDateTime": "2026-11-19T17:15:00",
      "title": "CSIT301_UGSEM5"
    },
    {
      "courseName": "Critical Reasoning",
      "endDateTime": "2025-02-14T18:10:00",
      "faculty": "Tanvi Joshi",
      "facultySalutation": "Prof.",
      "id": "a8HJ3000000PO3NMAW",
      "room": "APJ Abdul Kalam 104",
      "sessionTime": "17:15 - 18:10",
      "startDateTime": "2025-02-14T17:15:00",
      "title": "CRTL101_UGTERM3L"
    },
    {
      "courseName": "Business Ideation and Lean Startup",
      "endDateTime": "2026-03-02T12:55:00",
      "faculty": "Darshan Doshi",
      "facultySalutation": "Prof.",
      "id": "a8Hfv00000022LzEAI",
      "room": "Shantiniketan Seminar Room",
      "sessionTime": "12:00 - 12:55",
      "startDateTime": "2026-03-02T12:00:00",
      "title": "ENTS203_UGSEM4"
    },
    {
      "courseName": "Introduction to Finance and Accounting",
      "endDateTime": "2024-11-28T16:10:00",
      "faculty": "Gunturu Phani Sai Vamsikrishna",
      "facultySalutation": "Prof.",
      "id": "a8HJ3000000PIPIMA4",
      "room": "APJ Abdul Kalam 106",
      "sessionTime": "15:15 - 16:10",
      "startDateTime": "2024-11-28T15:15:00",
      "title": "FINC101_UGTERM2A"
    },
    {
      "courseName": "Theory of Computation",
      "endDateTime": "2026-01-16T15:10:00",
      "faculty": "Aamod Sane",
      "facultySalutation": "Dr.",
      "id": "a8Hfv0000001zxmEAA",
      "room": "APJ Abdul Kalam 009",
      "sessionTime": "14:15 - 15:10",
      "startDateTime": "2026-01-16T14:15:00",
      "title": "CSIT204_UGSEM4"
    },
    {
      "courseName": "Principles of Machine Learning",
      "endDateTime": "2026-10-08T16:10:0
... (truncated, see .json for full)
```

**call 13** — page: `https://my.flame.edu.in/s/calendar`, state: `SUCCESS`

params:
```json
{
  "namespace": "",
  "classname": "PortalEventController",
  "method": "getAllEvents",
  "cacheable": false,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": [
    {
      "endDate": "2026-07-08",
      "eventStatus": "Approved",
      "eventType": "Multi-day",
      "featuredEvents": false,
      "id": "aAUfv0000003gCPGAY",
      "imageUrl": "https://flame.lightning.force.com/sfc/dist/version/download/?oid=00D280000014pp8&ids=068fv00000RQVrx&d=%2Fa%2Ffv00000DqUP8%2FSsLMFcJwbgqb3rcrN3ckkQ8wiTFJThXxwLYck60sDjs&asPdf=false",
      "startDate": "2026-07-07",
      "title": "FLAME Economics Workshop"
    }
  ],
  "cacheable": false
}
```

**call 14** — page: `https://my.flame.edu.in/s/calendar`, state: `SUCCESS`

params:
```json
{
  "namespace": "",
  "classname": "PortalCreateServiceAndSupportTicketCntrl",
  "method": "getCases",
  "params": {
    "userId": "0055i00000CwfKqAAJ"
  },
  "cacheable": true,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": [
    {
      "closedOn": "-",
      "id": "500fv00000TqzMxAAJ",
      "raisedOn": "22 Aug 2026, 12:25PM",
      "requestId": "CRN-00611563",
      "status": "New",
      "statusClass": "status-badge status-new"
    },
    {
      "closedOn": "-",
      "id": "500J300000LItxtIAD",
      "raisedOn": "04 Apr 2025, 9:00AM",
      "requestId": "CRN-00480751",
      "status": "New",
      "statusClass": "status-badge status-new",
      "subject": "Nightout Request"
    },
    {
      "closedOn": "-",
      "id": "500J300000LK1JxIAL",
      "raisedOn": "10 Apr 2025, 2:31PM",
      "requestId": "CRN-00483086",
      "status": "New",
      "statusClass": "status-badge status-new",
      "subject": "Nightout Request"
    },
    {
      "closedOn": "-",
      "id": "500J300000MSDM1IAP",
      "raisedOn": "29 Apr 2025, 7:51PM",
      "requestId": "CRN-00489604",
      "status": "New",
      "statusClass": "status-badge status-new",
      "subject": "Nightout Request"
    },
    {
      "closedOn": "-",
      "id": "500J300000MSLupIAH",
      "raisedOn": "30 Apr 2025, 11:23AM",
      "requestId": "CRN-00489897",
      "status": "New",
      "statusClass": "status-badge status-new",
      "subject": "Nightout Request"
    },
    {
      "closedOn": "-",
      "id": "500fv000003l6ZhAAI",
      "raisedOn": "05 Sep 2025, 9:11AM",
      "requestId": "CRN-00510818",
      "status": "New",
      "statusClass": "status-badge status-new",
      "subject": "Nightout Request"
    },
    {
      "closedOn": "-",
      "id": "500fv000006mP3wAAE",
      "raisedOn": "16 Oct 2025, 1:09PM",
      "requestId": "CRN-00523428",
      "status": "New",
      "statusClass": "status-badge status-new",
      "subject": "Nightout Request"
    },
    {
      "closedOn": "-",
      "id": "500fv000007zDNjAAM",
      "raisedOn": "01 Nov 2025, 11:58AM",
      "requestId": "CRN-00527312",
      "status": "New",
      "statusClass": "status-badge status-new",
      "subject": "Nightout Request"
    },
    {
      "closedOn": "-",
      "id": "500fv000008pSFNAA2",
      "raisedOn": "12 Nov 2025, 3:08PM",
      "requestId": "CRN-00530150",
      "status": "New",
      "statusClass": "status-badge status-new",
      "subject": "Nightout Request"
    },
    {
      "closedOn": "-",
      "id": "500fv00000BU6Y0AAL",
      "raisedOn": "19 Dec 2025, 7:10PM",
      "requestId": "CRN-00543010",
      "status": "New",
      "statusClass": "status-badge status-new",
      "subject": "Nightout Request"
    },
    {
      "closedOn": "-",
      "id": "500fv00000D6xXNAAZ",
      "raisedOn": "14 Jan 2026, 7:21PM",
      "requestId": "CRN-00549723",
      "status": "New",
      "statusClass": "status-badge status-new",
      "subject": "Nightout Request"
    },
    {
      "closedOn": "-",
      "id": "500fv00000FCM2YAAX",
      "raisedOn": "14 Feb 2026, 12:46AM",
      "requestId": "CRN-00560181",
      "status": "New",
      "statusClass": "status-badge status-new",
      "subject": "N
... (truncated, see .json for full)
```

**call 15** — page: `https://my.flame.edu.in/s/calendar`, state: `SUCCESS`

params:
```json
{
  "namespace": "",
  "classname": "GoogleCalendarUserService",
  "method": "getConnectionStatus",
  "cacheable": false,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": {
    "account": "rudra.krishna@flame.edu.in",
    "accountMismatch": false,
    "configured": true,
    "connected": true,
    "linkCount": 2,
    "signedInAs": "rudra.krishna@flame.edu.in"
  },
  "cacheable": true
}
```

**call 16** — page: `https://my.flame.edu.in/s/calendar`, state: `SUCCESS`

params:
```json
{
  "namespace": "",
  "classname": "ResourceController",
  "method": "getCategoriesWithResources",
  "cacheable": true,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": [
    {
      "value": "Academic",
      "label": "Academic Resources"
    },
    {
      "value": "Technology",
      "label": "ERP Resources"
    },
    {
      "value": "Campus",
      "label": "Campus Resources"
    },
    {
      "value": "Research",
      "label": "Research Resources"
    },
    {
      "value": "IRB",
      "label": "IRB Resources"
    }
  ],
  "cacheable": true
}
```

**call 17** — page: `https://my.flame.edu.in/s/calendar`, state: `SUCCESS`

params:
```json
{
  "namespace": "",
  "classname": "PortalAllFeedsCtrl",
  "method": "getAllEvents",
  "cacheable": true,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": [
    {
      "Id": "a2h0K000001DOZTQA4",
      "Content__c": "<a href=\"https://www.thehindu.com/entertainment/music/divine-on-his-new-album-punya-paap-and-working-with-nas-and-dutchavelli/article33306326.ece\" target=\"_blank\">https://www.thehindu.com/entertainment/music/divine-on-his-new-album-punya-paap-and-working-with-nas-and-dutchavelli/article33306326.ece</a>",
      "Heading__c": "Rapper DIVINE discusses his new album (by Prof Lalitha Suhasini in thehindu.com)",
      "Image__c": "/servlet/servlet.FileDownload?file=00P0K00001sPKjdUAG",
      "RecordTypeId": "0120K0000019nisQAA",
      "Available_Seats__c": 0,
      "IsActive__c": true,
      "Role__c": "Student;Faculty;Staff",
      "LastModifiedDate": "2026-07-10T07:04:12.000Z",
      "RecordType": {
        "Name": "News",
        "Id": "0120K0000019nisQAA"
      }
    },
    {
      "Id": "a2hfv000003R389AAC",
      "Content__c": "<p>Expert Talk on India\u2019s Foreign Policy: Emerging Priorities and Policy Continuity by Shri. Vijay Gokhale, Former Foreign Secretary of India</p><p><a href=\"https://www.flame.edu.in/flame-events/icals.icalrepeat/-?tmpl=component&amp;evid=903\" target=\"_blank\"><img src=\"https://www.flame.edu.in/images/events/ical-icon-.jpg\" alt=\"Save to iCal\"></img></a></p><p><a href=\"http://www.google.com/calendar/event?action=TEMPLATE&amp;text=Expert+Talk+on+India%E2%80%99s+Foreign+Policy%3A+Emerging+Priorities+and+Policy+Continuity+by+Shri.+Vijay+Gokhale%2C+Former+Foreign+Secretary+of+India&amp;dates=20260225T141500%2F20260225T235959&amp;ctz=Asia%2FKolkata&amp;location=CHK001&amp;trp=false&amp;sprop=FLAME+University&amp;sprop=name%3Ahttps%3A%2F%2Fwww.flame.edu.in%2F&amp;details=This+distinguished+event+is+organised+in+collaboration+with+the+Organisation+for+Research+on+China+and+Asia+%28ORCA%29%2C+New+Delhi%2C+under+the+aegis+of+the%C2%A0FLAME%E2%80%93ORCA+Memorandum+of+Understanding%2C+which+has+been+in+effect+since+the+academic+year+2023-24.%0D%0AAbout+the+Speaker%0D%0AShri.+Vijay+Gokhale+is+a+distinguished+Indian+diplomat+and+scholar+who+served+as+India%E2%80%99s+Foreign+Secretary+from+January+2018+to+January+2020.+A+career+member+of+the+Indian+Foreign+Service+%281981+batch%29%2C+he+has+held+several+critical+d+...\" target=\"_blank\"><img src=\"https://www.flame.edu.in/images/events/google-calendar-icon.jpg\" alt=\"Add to Google Calendar\"></img></a></p><p>Wednesday, February 25, 2026,\u00a002:15pm</p><p> <a href=\"https://www.flame.edu.in/flame-events/monthcalendar/2026/02/104\" target=\"_blank\">Lecture / Reading / Talk</a></p><p> </p><p><br></p><p>This distinguished event is organised in collaboration with the Organisation for Research on China and Asia (ORCA), New Delhi, under the aegis of the\u00a0FLAME\u2013ORCA Memorandum of Understanding, which has been in effect since the academic year 2023-24.</p><h3>About the Speaker</h3><p>Shri. Vijay Gokhale is a distinguished Indian diplomat and scholar who served as India\u2019s Foreign Se
... (truncated, see .json for full)
```

**call 18** — page: `https://my.flame.edu.in/s/calendar`, state: `SUCCESS`

params:
```json
{
  "namespace": "",
  "classname": "PortalAllFeedsCtrl",
  "method": "getCurrentUserContactId",
  "cacheable": false,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": "0035i0000H4spWxAQI",
  "cacheable": false
}
```

**call 19** — page: `https://my.flame.edu.in/s/calendar`, state: `SUCCESS`

params:
```json
{
  "namespace": "",
  "classname": "QuickLinkController",
  "method": "getRecentQuickLinks",
  "cacheable": true,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": [],
  "cacheable": true
}
```

**call 20** — page: `https://my.flame.edu.in/s/calendar`, state: `ERROR`

params:
```json
{
  "namespace": "",
  "classname": "GoogleCalendarUserService",
  "method": "fetchEvents",
  "cacheable": false,
  "isContinuation": false
}
```

returnValue:
```json
{
  "cacheable": false
}
```

error: `[{'message': 'Your user is linked to 2 Google accounts, so we cannot tell which calendar to load. Ask an admin to remove the extras.'}]`

**call 21** — page: `https://my.flame.edu.in/s/`, state: `SUCCESS`

params:
```json
{
  "namespace": "",
  "classname": "CustomBookingController",
  "method": "getResources",
  "cacheable": true,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": "[{\"resources\":[{\"resourceId\":\"a230K00000945JHQAY\",\"name\":\"Gym ( 6:00 am to 2:00 pm slot )\"},{\"resourceId\":\"a230K00000945K5QAI\",\"name\":\"Swimming Pool\"},{\"resourceId\":\"a235i000000nYV0AAM\",\"name\":\"Gym ( 3:00 pm to 11:00 pm slot )\"}],\"facility_Name\":\"Sports Facilities\"},{\"resources\":[{\"resourceId\":\"a230K00000945IiQAI\",\"name\":\"Library - Discussion Room A\"},{\"resourceId\":\"a230K00000945KFQAY\",\"name\":\"Library - Discussion Room C\"},{\"resourceId\":\"a230K00000945KKQAY\",\"name\":\"Library - Discussion Room B\"},{\"resourceId\":\"a230K00000945LrQAI\",\"name\":\"Chandragupta - Focus Room 201 W\"},{\"resourceId\":\"a230K00000945LwQAI\",\"name\":\"Chandragupta - Focus Room 301 W\"},{\"resourceId\":\"a235i000000tGUuAAM\",\"name\":\"Chandragupta - Amphitheatre\"}],\"facility_Name\":\"Conference Rooms\"},{\"resources\":[{\"resourceId\":\"a230K00000945MQQAY\",\"name\":\"Aryabhata - ARB001\"},{\"resourceId\":\"a230K00000945MVQAY\",\"name\":\"Aryabhata - ARB004\"},{\"resourceId\":\"a235i000000tG5kAAE\",\"name\":\"Aryabhata - ARB002\"},{\"resourceId\":\"a235i000000tG5pAAE\",\"name\":\"Aryabhata - ARB101\"},{\"resourceId\":\"a235i000000tG5uAAE\",\"name\":\"Aryabhata - ARB102\"},{\"resourceId\":\"a235i000000tG5zAAE\",\"name\":\"Aryabhata - ARB103\"},{\"resourceId\":\"a235i000000tG64AAE\",\"name\":\"Aryabhata - ARB104\"},{\"resourceId\":\"a235i000000tG69AAE\",\"name\":\"Aryabhata - ARB201\"},{\"resourceId\":\"a235i000000tG6EAAU\",\"name\":\"Aryabhata - ARB202\"},{\"resourceId\":\"a235i000000tG6JAAU\",\"name\":\"Aryabhata - ARB203\"},{\"resourceId\":\"a235i000000tG6OAAU\",\"name\":\"Aryabhata - ARB204\"},{\"resourceId\":\"a23fv000001syHxAAI\",\"name\":\"Digital Learning Lab - Studio 102\"},{\"resourceId\":\"a23fv000001t0q1AAA\",\"name\":\"Digital Learning Lab - Studio 103\"}],\"facility_Name\":\"Class Rooms\"}]",
  "cacheable": true
}
```

**call 22** — page: `https://my.flame.edu.in/s/`, state: `SUCCESS`

params:
```json
{
  "namespace": "",
  "classname": "CustomBookingController",
  "method": "getResourceAvailability",
  "params": {
    "resourceId": "a230K00000945JHQAY",
    "bookingDate": "2026-08-31"
  },
  "cacheable": false,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": "Booking date cannot be in the past.",
  "cacheable": false
}
```

**call 23** — page: `https://my.flame.edu.in/s/book-slot`, state: `SUCCESS`

params:
```json
{
  "namespace": "",
  "classname": "CustomBookingController",
  "method": "getResourceAvailability",
  "params": {
    "resourceId": "a230K00000945JHQAY",
    "bookingDate": "2026-09-01"
  },
  "cacheable": false,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": "No slot available.",
  "cacheable": false
}
```

**call 24** — page: `https://my.flame.edu.in/s/`, state: `SUCCESS`

params:
```json
{
  "namespace": "",
  "classname": "CustomBookingController",
  "method": "getReservations",
  "params": {
    "userId": "0055i00000CwfKqAAJ"
  },
  "cacheable": true,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": [
    {
      "bookingId": "R-714794",
      "endDate": "2026-09-01",
      "endDateTime": "01/09/2026, 7:00 AM",
      "resourceName": "Gym ( 6:00 am to 2:00 pm slot )",
      "startDate": "2026-09-01",
      "startDateTime": "01/09/2026, 6:00 AM",
      "status": "Canceled"
    },
    {
      "bookingId": "R-713759",
      "endDate": "2026-08-31",
      "endDateTime": "31/08/2026, 9:00 AM",
      "resourceName": "Gym ( 6:00 am to 2:00 pm slot )",
      "startDate": "2026-08-31",
      "startDateTime": "31/08/2026, 8:00 AM",
      "status": "Booked"
    },
    {
      "bookingId": "R-712153",
      "endDate": "2026-08-29",
      "endDateTime": "29/08/2026, 9:00 AM",
      "resourceName": "Gym ( 6:00 am to 2:00 pm slot )",
      "startDate": "2026-08-29",
      "startDateTime": "29/08/2026, 8:00 AM",
      "status": "Booked"
    },
    {
      "bookingId": "R-709741",
      "endDate": "2026-08-26",
      "endDateTime": "26/08/2026, 8:00 AM",
      "resourceName": "Gym ( 6:00 am to 2:00 pm slot )",
      "startDate": "2026-08-26",
      "startDateTime": "26/08/2026, 7:00 AM",
      "status": "Booked"
    },
    {
      "bookingId": "R-708458",
      "endDate": "2026-08-25",
      "endDateTime": "25/08/2026, 8:00 AM",
      "resourceName": "Gym ( 6:00 am to 2:00 pm slot )",
      "startDate": "2026-08-25",
      "startDateTime": "25/08/2026, 7:00 AM",
      "status": "Booked"
    },
    {
      "bookingId": "R-704813",
      "endDate": "2026-08-20",
      "endDateTime": "20/08/2026, 8:00 AM",
      "resourceName": "Gym ( 6:00 am to 2:00 pm slot )",
      "startDate": "2026-08-20",
      "startDateTime": "20/08/2026, 7:00 AM",
      "status": "Booked"
    },
    {
      "bookingId": "R-703048",
      "endDate": "2026-08-19",
      "endDateTime": "19/08/2026, 8:00 AM",
      "resourceName": "Gym ( 6:00 am to 2:00 pm slot )",
      "startDate": "2026-08-19",
      "startDateTime": "19/08/2026, 7:00 AM",
      "status": "Booked"
    },
    {
      "bookingId": "R-702401",
      "endDate": "2026-08-18",
      "endDateTime": "18/08/2026, 9:00 AM",
      "resourceName": "Gym ( 6:00 am to 2:00 pm slot )",
      "startDate": "2026-08-18",
      "startDateTime": "18/08/2026, 8:00 AM",
      "status": "Booked"
    },
    {
      "bookingId": "R-701016",
      "endDate": "2026-08-16",
      "endDateTime": "16/08/2026, 9:00 PM",
      "resourceName": "Gym ( 3:00 pm to 11:00 pm slot )",
      "startDate": "2026-08-16",
      "startDateTime": "16/08/2026, 8:00 PM",
      "status": "Booked"
    },
    {
      "bookingId": "R-700638",
      "endDate": "2026-08-14",
      "endDateTime": "14/08/2026, 9:00 PM",
      "resourceName": "Gym ( 3:00 pm to 11:00 pm slot )",
      "startDate": "2026-08-14",
      "startDateTime": "14/08/2026, 8:00 PM",
      "status": "Booked"
    },
    {
      "bookingId": "R-692310",
      "endDate": "2026-04-24",
      "endDateTime": "24/04/2026, 9:00 AM",
      "resourceName": "Gym ( 6:00 am to 2:00 pm slot )",
      
... (truncated, see .json for full)
```

**call 25** — page: `https://my.flame.edu.in/s/`, state: `SUCCESS`

params:
```json
{
  "namespace": "vnai",
  "classname": "AiAssistantWindowController",
  "method": "getAssistant",
  "params": {
    "assistantName": "Gyan",
    "recordId": ""
  },
  "cacheable": true,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": {
    "assistantId": "asst_bt45bMuv1750873146378",
    "assistantTimeout": 60000.0,
    "displayName": "Gyan",
    "enableFileUpload": false,
    "introductionText": "Nice to see you here! Tap \"Start chat\" button to begin and explore AI-powered conversations with Gyan.",
    "logo": "https://flame.file.force.com/sfc/dist/version/download/?oid=00D280000014pp8&ids=068fv0000034GCc&d=%2Fa%2Ffv000001RANh%2FqptgVfJwNZcmd0NsNOJifPjVAenPt6GScBn6UJIkWVc&asPdf=false",
    "name": "Gyan",
    "storeFileInSFDC": true,
    "welcomeMessage": "Welcome to Gyan"
  },
  "cacheable": true
}
```

**call 26** — page: `https://my.flame.edu.in/s/`, state: `SUCCESS`

params:
```json
{
  "namespace": "vnai",
  "classname": "AiAssistantWindowController",
  "method": "getUserThread",
  "params": {
    "assistantId": "",
    "actorId": "0055i00000CwfKqAAJ",
    "createIfNotExists": true,
    "refreshToken": 0
  },
  "cacheable": true,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": {},
  "cacheable": true
}
```

**call 27** — page: `https://my.flame.edu.in/s/`, state: `SUCCESS`

params:
```json
{
  "namespace": "vnai",
  "classname": "AiAssistantWindowController",
  "method": "getUserThread",
  "params": {
    "assistantId": "asst_bt45bMuv1750873146378",
    "actorId": "0055i00000CwfKqAAJ",
    "createIfNotExists": true,
    "refreshToken": 0
  },
  "cacheable": true,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": {},
  "cacheable": true
}
```

**call 28** — page: `https://my.flame.edu.in/s/`, state: `SUCCESS`

params:
```json
{
  "namespace": "",
  "classname": "CustomBookingController",
  "method": "createReservation",
  "params": {
    "dateSelected": "2026-09-01",
    "startTime": "6:00 AM",
    "endTime": "7:00 AM",
    "resource": "a230K00000945JHQAY",
    "bookingPurpose": "",
    "coAttendee": "",
    "userId": "0055i00000CwfKqAAJ"
  },
  "cacheable": false,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": "Booking request submitted successfully with Booking Id R-714794. Check your email for updates. Thank you.",
  "cacheable": false
}
```

**call 29** — page: `https://my.flame.edu.in/s/`, state: `SUCCESS`

params:
```json
{
  "namespace": "",
  "classname": "CustomBookingController",
  "method": "cancelReservation",
  "params": {
    "userId": "0055i00000CwfKqAAJ",
    "bookingId": "R-714794"
  },
  "cacheable": false,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": "Booking with R-714794 has been cancelled successfully.",
  "cacheable": false
}
```

**call 30** — page: `https://my.flame.edu.in/s/book-slot`, state: `SUCCESS`

params:
```json
{
  "namespace": "",
  "classname": "CustomBookingController",
  "method": "getResourceAvailability",
  "params": {
    "resourceId": "a235i000000nYV0AAM",
    "bookingDate": "2026-09-01"
  },
  "cacheable": false,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": "No slot available.",
  "cacheable": false
}
```

**call 31** — page: `https://my.flame.edu.in/s/book-slot`, state: `SUCCESS`

params:
```json
{
  "namespace": "",
  "classname": "CustomBookingController",
  "method": "getResourceAvailability",
  "params": {
    "resourceId": "a230K00000945JHQAY",
    "bookingDate": "2026-09-02"
  },
  "cacheable": false,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": "{\"resourceId\":\"a230K00000945JHQAY\",\"availabilitySlots\":[{\"startTime\":\"6:00 AM\",\"endTime\":\"7:00 AM\",\"availableDate\":null,\"availableCapacity\":21},{\"startTime\":\"7:00 AM\",\"endTime\":\"8:00 AM\",\"availableDate\":null,\"availableCapacity\":1},{\"startTime\":\"8:00 AM\",\"endTime\":\"9:00 AM\",\"availableDate\":null,\"availableCapacity\":8},{\"startTime\":\"9:00 AM\",\"endTime\":\"10:00 AM\",\"availableDate\":null,\"availableCapacity\":15},{\"startTime\":\"10:00 AM\",\"endTime\":\"11:00 AM\",\"availableDate\":null,\"availableCapacity\":8},{\"startTime\":\"11:00 AM\",\"endTime\":\"12:00 PM\",\"availableDate\":null,\"availableCapacity\":21},{\"startTime\":\"12:00 PM\",\"endTime\":\"1:00 PM\",\"availableDate\":null,\"availableCapacity\":5},{\"startTime\":\"1:00 PM\",\"endTime\":\"2:00 PM\",\"availableDate\":null,\"availableCapacity\":19}]}",
  "cacheable": false
}
```

**call 32** — page: `https://my.flame.edu.in/s/book-slot`, state: `SUCCESS`

params:
```json
{
  "namespace": "",
  "classname": "CustomBookingController",
  "method": "createReservation",
  "params": {
    "dateSelected": "2026-09-02",
    "startTime": "8:00 AM",
    "endTime": "9:00 AM",
    "resource": "a230K00000945JHQAY",
    "bookingPurpose": "",
    "coAttendee": "",
    "userId": "0055i00000CwfKqAAJ"
  },
  "cacheable": false,
  "isContinuation": false
}
```

returnValue:
```json
{
  "returnValue": "More than 1 bookings are not allowed for selected resource.",
  "cacheable": false
}
```


---

