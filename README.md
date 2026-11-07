# Herald Portal

## LiveKit live classrooms

Live classes are embedded in `public/live-classroom.html` and use the official LiveKit React components. The server issues short lived participant tokens after checking the portal session, role, course assignment or enrollment, class status, and class end time. LiveKit API credentials are used only by the Node server.

### Backend environment

Set these values in the backend service environment (for local development, `.env`):

```env
LIVEKIT_URL=wss://YOUR_LIVEKIT_CLOUD_PROJECT_URL
LIVEKIT_API_KEY=YOUR_LIVEKIT_API_KEY
LIVEKIT_API_SECRET=YOUR_LIVEKIT_API_SECRET
```

Use the WebSocket URL and key pair shown in the Herald Trainer project in LiveKit Cloud. Do not add these as frontend/build variables or commit them. The database schema updates run idempotently at portal startup. The existing app database client is Turso/libSQL (`TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`); the live class tables and existing attendance integration therefore use that same configured database.

### LiveKit Cloud webhook

In the LiveKit Cloud project settings, add a webhook with URL `https://heraldtrainer.co.ke/api/livekit/webhook`, choose the LiveKit API key as the signing key, and subscribe to `participant_joined`, `participant_left`, and `room_finished`. The endpoint validates LiveKit's signed request body before saving an event. LiveKit webhook retries are supported and duplicate event IDs are ignored.

### Class lifecycle and attendance

Lecturers create classes for courses assigned to them. At the scheduled start, the lecturer opens the in-portal classroom and starts it; enrolled students can then join. A server-side timer ends rooms at the scheduled end, closes open student attendance sessions, saves each student's total duration and status, and marks the class completed. The timer schedule is recovered from the database at startup and checked periodically, so restarting the portal does not lose scheduled endings. The lecturer can end a live room early. Administrators can inspect active participants and filter or export the historical attendance report from the Live Classes panel.

The service must remain running for the 15-second worker to enforce the scheduled end promptly. On restart, the worker immediately reconciles overdue classes. Keep the Render service on an always-on instance for live classes; a sleeping instance cannot execute jobs while asleep.

`npm start` builds the classroom bundle before starting the portal. `npm run build:classroom` can also be run manually. The static React bundle contains only public UI code; LiveKit secrets stay in the server environment.

## Academic document rendering

The Academic Document Studio uses its local `html-to-image` bundle to export the certificate element as a high-resolution PNG. Issued-document PDFs are generated directly with PDFKit and the bundled fonts, so student view, download, and print do not depend on Chrome. Puppeteer remains available for server-side PNG exports; its install step downloads a pinned Chrome browser, so deployment builds must allow that step to run. If the host provides its own browser, set `PUPPETEER_EXECUTABLE_PATH` (or `CHROME_PATH`) to its executable path. Bundled fonts, school branding, and QR generation are local assets; no external font or QR service is required.
