# LearnPy → LearnPy2 Migration Guide (Flask/Jinja → React + Python API)

> It explains *what* to build and *why*, with checkpoints. It deliberately does **not**
> hand you finished code.
>
> **Ground rule for LearnPy2, "No AI":** I write all of the code myself. Claude is used only to
> review my code, point out bugs and help plan architecture. It doesn't write features for me.
> (This is about how the project is built. The product itself may still have an AI tutor, see §6 and §10.)

---

## 1. How the old project works (LearnPy / `aiCodeGenerator`)

### 1.1 The big picture

```
Browser ──HTTP──▶ Flask (flask_app.py, ~900 lines)
                   ├─ Jinja renders full HTML pages (templates/*.html)
                   ├─ a few JSON endpoints for fetch() calls
                   ├─ Flask-Login session cookie for auth
                   ├─ SQLAlchemy → SQLite (dev) / Postgres (prod)
                   └─ Anthropic SDK → Claude (AI tutor)

Inside the browser (vanilla JS inside main.html, ~1900 lines):
   ├─ Pyodide (Python in WASM) runs challenge tests locally
   ├─ debounced autocomplete against /api/search/suggest
   ├─ EventSource streaming of AI lessons from /generate/stream
   └─ marked.js renders Markdown
```

The server does **two jobs at once**: it is the *data source* and the *UI renderer*.
The core of this migration is splitting those two jobs: **React takes the UI, and Python keeps the data.**

### 1.2 Module map: what each file does and where it goes

| Old file | Responsibility | In LearnPy2 |
|---|---|---|
| `topics.py` | Catalog: 3 parents + ~58 sub-topics (slug, name, icon, children, related) | **Keep in the backend.** Served as JSON by `GET /api/topics` |
| `lessons.py` + `lessons/*.md` | Loads Markdown lesson bodies with frontmatter | **Keep the backend files.** Served by `GET /api/lessons/:slug` |
| `challenges.py` + `challenges_data.py` | `{prompt, starter_code, tests}` per slug | **Keep the backend.** Returned inside the lesson response |
| `cheatsheets.py` + `cheatsheets/*.json` | Cheat sheet data (sections → rows of sig/example/result) | **Keep the backend.** `GET /api/cheatsheets`, `GET /api/cheatsheets/:slug` |
| `diagram_sequences.py` + `static/diagrams/` | Step-through image diagrams per lesson | The data stays in the backend. The images move to `front-end/public/diagrams/` |
| `search_index.py` | SQLite FTS5 index built at startup from lessons. BM25 ranking | **Keep as-is.** Pure Python, so it ports without changes |
| `topic_resolver.py` | Maps free text → catalog slug (strict and fuzzy) | **Keep as-is** |
| `profile_data.py` | Pure function: heatmap weeks and streak stats | **Keep as-is.** Returned by `GET /api/profile` |
| `models.py` | `User`, `Generation`, `LessonProgress` | **Keep.** Same schema, and the Alembic migrations come with it |
| `reset_tokens.py`, `mailer.py` | Password-reset tokens and email | **Keep** |
| `generator.py`, `stream_utils.py` | Claude calls, RAG context, streaming splitter | **Optional, see §6.** Only if LearnPy2 keeps an AI tutor |
| `flask_app.py` | Routes, auth decorators, guest mode, rate limit, error handler | **Rewrite** as a JSON-only API (it gets smaller) |
| `templates/*.html` | All UI, including the 1900-line `main.html` doing three jobs | **Replace** with React components |
| `static/js/diagram-player.js` | Diagram stepper | **Replace** with a `<DiagramPlayer>` component |
| `tests/` | pytest for pure modules and auth | **Keep.** Add frontend tests with Vitest |

**Key insight:** about 60% of the old Python is already pure, Flask-free logic
(`search_index`, `topic_resolver`, `profile_data`, `stream_utils`, the loaders). It can be
copied over nearly verbatim. The work is in the **UI layer** and in turning **routes into JSON**.

### 1.3 Things the old app does that are easy to lose in a rewrite

Write these down as acceptance criteria:

- **Guest mode.** `POST /guest` sets `session["guest"]`. Guests can read lessons, run challenges and use the tutor (rate-limited), but cannot save progress. There are two decorators: `login_or_guest_required` and `account_required`, which bounces a guest to signup.
- **Guest rate limit** on the AI tutor: an in-memory sliding window keyed by a random id in the cookie.
- **Front-door redirect.** If a tutor query exactly matches a catalog topic, the stream emits `{"redirect": "/lesson/<slug>"}` instead of calling Claude.
- **JSON error handler.** Any uncaught exception becomes JSON, so `fetch().json()` never chokes on an HTML 500 page.
- **Stale-response guard** in autocomplete. Results that come back after the user kept typing are discarded.
- **Progress icons.** An eyeball means viewed and a check means completed, shown on topic grids and the sidebar. The "✓ CHALLENGE COMPLETE" badge persists.
- **Each Pyodide test runs in a fresh globals dict**, so tests can't leak state.
- **Keyboard shortcuts**: `Cmd/Ctrl+Enter` runs tests, `↑ ↓ Enter Esc` work in autocomplete, `Esc` closes the sidebar.
- **Password reset flow**, including the `password_reset_at` invalidation of old tokens.
- **Slug validation** on `POST /api/progress/complete`, so clients can't insert arbitrary keys.

---

## 2. Target architecture for LearnPy2

### 2.1 Recommendation

**React (Vite + TypeScript) frontend + Flask JSON API backend.**

Why keep Flask instead of switching to FastAPI or Node right away:
- You already know Flask, so you learn **one** new big thing (React) instead of two at once.
- Nearly all of your pure Python modules and tests carry over.
- Pyodide runs in the browser either way, so the backend language doesn't matter for challenges.

(FastAPI is a good *later* exercise: typed request models and auto-generated docs. Swapping the
API layer once the React side is stable is a contained, well-defined project.)

### 2.2 Repo layout

LearnPy2 already has `front-end/`. Add a `back-end/` folder next to it:

```
LearnPy2/
├── front-end/                  # Vite + React + TS (exists)
│   ├── public/
│   │   ├── logo.png
│   │   └── diagrams/...        # moved from old static/diagrams
│   ├── src/
│   │   ├── main.tsx            # mounts <App/> inside <BrowserRouter>
│   │   ├── App.tsx             # route table + layout
│   │   ├── api/                # ONE place that calls fetch()
│   │   │   ├── client.ts       # base fetch wrapper (credentials, JSON errors)
│   │   │   └── types.ts        # TS types mirroring API responses
│   │   ├── context/
│   │   │   ├── AuthContext.tsx # current user / guest / logged-out
│   │   │   └── CatalogContext.tsx # topics list, fetched once
│   │   ├── hooks/
│   │   │   ├── useDebounce.ts
│   │   │   ├── usePyodide.ts
│   │   │   └── useProgress.ts
│   │   ├── components/
│   │   │   ├── Navbar.tsx      # exists
│   │   │   ├── TopicSidebar.tsx
│   │   │   ├── SearchBar.tsx   # autocomplete
│   │   │   ├── LessonBody.tsx  # markdown rendering
│   │   │   ├── ChallengeRunner.tsx
│   │   │   ├── DiagramPlayer.tsx
│   │   │   ├── TopicGrid.tsx
│   │   │   └── Heatmap.tsx
│   │   └── pages/
│   │       ├── HomePage.tsx
│   │       ├── LessonsPage.tsx
│   │       ├── LessonPage.tsx
│   │       ├── CheatSheetsPage.tsx
│   │       ├── CheatSheetPage.tsx
│   │       ├── AboutPage.tsx
│   │       ├── ProfilePage.tsx
│   │       ├── LoginPage.tsx / SignupPage.tsx
│   │       └── ForgotPasswordPage.tsx / ResetPasswordPage.tsx
│   └── vite.config.ts          # add dev proxy: /api → localhost:5000
│
├── back-end/
│   ├── app.py                  # create_app(), blueprints, error handler
│   ├── routes/                 # split the old 900-line file up
│   │   ├── catalog.py          # topics, lessons, cheatsheets, search
│   │   ├── auth.py             # signup/login/logout/me/guest/reset
│   │   ├── progress.py         # progress + profile
│   │   └── tutor.py            # (optional) AI generation
│   ├── models.py
│   ├── topics.py, lessons.py, challenges_data.py, cheatsheets.py, ...
│   ├── content/lessons/*.md    # moved
│   ├── content/cheatsheets/*.json
│   ├── migrations/
│   ├── tests/
│   └── requirements.txt
│
└── main.py                     # replace or remove once back-end/app.py exists
```

### 2.3 Old page routes → new React routes

| Old Flask route (renders HTML) | New React route (`react-router`) | Data it fetches |
|---|---|---|
| `/` | `/` | `/api/topics`, `/api/progress` |
| (sidebar drawer) | `/lessons` (your navbar already links here) | `/api/topics` |
| `/lesson/<slug>` | `/lesson/:slug` | `/api/lessons/:slug` |
| `/cheatsheet/<slug>` | `/cheat-sheets` and `/cheat-sheets/:slug` | `/api/cheatsheets[/:slug]` |
| `/about` | `/about` | none |
| `/profile` | `/profile` | `/api/profile?year=&month=` |
| `/login`, `/signup` | same | POST only |
| `/forgot-password`, `/reset-password` | same | POST only |

> Fix the casing on your navbar link: `/Lessons` should be `/lessons`. Also switch `<a href>` to
> react-router's `<Link to>`. Plain anchors reload the whole app on every click.

### 2.4 The API contract (the most important artifact here)

Write this down **before** coding either side. Both halves are built against it.

| Method & path | Auth | Returns |
|---|---|---|
| `GET /api/topics` | public | `[{slug, name, icon, level, description, children[], hide_from_sidebar}]` |
| `GET /api/lessons/:slug` | public or guest | `{slug, title, summary, markdown, related[{slug,name}], children[], challenge?{prompt, starter_code, tests[]}, diagram?[{src, caption}]}` |
| `GET /api/cheatsheets` | public | `[{slug, title, summary, icon}]` |
| `GET /api/cheatsheets/:slug` | public | full cheat sheet JSON |
| `GET /api/search/suggest?q=` | public | `[{slug, name, snippet}]` (max ~8) |
| `GET /api/auth/me` | any | `{status: "user", user:{id, username}}`, `{status: "guest"}` or `{status: "anonymous"}` |
| `POST /api/auth/signup` | none | `{user}` or `{error}` 400 |
| `POST /api/auth/login` | none | `{user}` or `{error}` 401 |
| `POST /api/auth/logout` | user | `{ok:true}` (**POST**, not GET as in the old app) |
| `POST /api/auth/guest` | none | `{status:"guest"}` |
| `POST /api/auth/forgot-password` | none | `{ok:true}` always (don't leak whether an email exists) |
| `POST /api/auth/reset-password` | token | `{ok:true}` or `{error}` |
| `GET /api/progress` | user | `{[slug]: {viewed: bool, completed: bool}}` |
| `POST /api/progress/view` | user | `{ok:true}` (old app did this as a side effect of page render) |
| `POST /api/progress/complete` | user | `{ok:true}`, or 400 for an unknown slug |
| `GET /api/profile?year&month` | user | output of `profile_data` |
| `GET /api/tutor/stream?prompt=` | user/guest | SSE (see §6), optional |

Every error, of every kind, returns `{"error": "message"}` with a proper status code. Port the old
`@app.errorhandler(Exception)` exactly. It matters even more now that 100% of traffic is `fetch()`.

---

## 3. Concepts that change (and what to learn for each)

| In the old app you did… | In React you'll… | Learn |
|---|---|---|
| Jinja `{% if active_lesson %}` in one giant template | Separate page components chosen by the router | `react-router` (v7) `<Routes>`, `useParams`, `useNavigate` |
| Context processors (`inject_topics`) put data in every template | Fetch once and share via **Context** | `createContext`, `useContext`, custom provider |
| `current_user` in templates | `AuthContext` populated from `GET /api/auth/me` on app load | Context and loading states |
| `document.getElementById(...).innerHTML = ...` | State drives the UI: `setX(...)` and React re-renders | `useState`, rendering lists with `key` |
| `addEventListener` setup scripts | Event props (`onChange`, `onKeyDown`) and `useEffect` for side effects | `useEffect` dependencies and cleanup |
| Manual stale-response guard | `AbortController` cancels the old fetch in the effect cleanup | Effect cleanup functions |
| `marked.js` + `innerHTML` | `react-markdown` (escapes HTML by default, so no XSS) + a highlighter | Why to avoid `dangerouslySetInnerHTML` |
| `@login_required` redirect | A `<RequireAuth>` wrapper route that `<Navigate>`s to `/login` | Protected routes. The **server still enforces** auth: client guards are only UX |
| Tailwind CDN | Plain CSS files like your Navbar.css, or CSS modules, or install Tailwind via its Vite plugin | Pick one and stay consistent |

---

## 4. Step-by-step implementation plan

Each phase ends with a **checkpoint** you can demo. Don't start the next phase until the
checkpoint works. Commit at every checkpoint.

### Phase 0: Plumbing (½ day)
1. Create `back-end/` with a minimal Flask app exposing `GET /api/health → {"ok": true}`.
2. In `vite.config.ts`, add a `server.proxy` entry that sends `/api` to `http://localhost:5000`.
   This makes the browser think frontend and backend share an origin, so **cookies just work
   and you need no CORS setup in dev**.
3. Install `react-router` and wrap `<App/>` in `<BrowserRouter>` in `main.tsx`.
4. Create `src/api/client.ts`: one function that calls `fetch`, parses JSON, and throws a
   typed error when `!res.ok`. Every request goes through it.

**Checkpoint:** a page shows "API ok" fetched from Flask through the proxy.

### Phase 1: Read-only catalog (the heart of the app)
1. Copy `topics.py`, `lessons.py`, `lessons/*.md`, `challenges_data.py`, `challenges.py`
   and `diagram_sequences.py` into `back-end/`. Copy the related tests and run `pytest`.
2. Implement `GET /api/topics` and `GET /api/lessons/:slug`. Port `_resolve_children` and
   `_resolve_related` from `flask_app.py` so the response already contains `{slug, name}` pairs.
3. Write `src/api/types.ts` with `Topic`, `Lesson` and `Challenge` interfaces that match the JSON.
4. Build `CatalogContext` (fetch topics once), then `LessonsPage` / `TopicGrid` and `LessonPage`.
5. Render lesson Markdown with `react-markdown`. Add syntax highlighting for code blocks.
6. A parent topic (one with children) shows a grid of children. A leaf shows the lesson body.
   This is the "triple duty" logic from `main.html`, split into components.

**Checkpoint:** you can browse every topic and read every lesson. Nothing interactive yet.

### Phase 2: Challenge runner (Pyodide)
1. Build `ChallengeRunner`: prompt, editor, Run/Reset buttons and a results list.
   Start with a `<textarea>`. Later, upgrade to CodeMirror (`@uiw/react-codemirror` + `@codemirror/lang-python`).
2. Write `usePyodide()`: lazy-load Pyodide only on the first Run click, and keep the instance
   in a module-level promise so it loads once per tab. Read the old `getPyodide()` and
   `runChallenge()` in `templates/main.html` (around lines 1577–1700) for the exact test-running approach:
   a fresh globals dict per test, and cleaned-up error messages.
3. *(Stretch, recommended)* Run Pyodide inside a **Web Worker**. Then an infinite loop in user
   code can't freeze the page, and you can kill the worker after a timeout. The old app couldn't do this.
4. Add `Cmd/Ctrl+Enter` to run.

**Checkpoint:** every challenge passes with a correct solution and fails with a wrong one.

### Phase 3: Search autocomplete
1. Copy `search_index.py` + `topic_resolver.py` and their tests. Build the index at startup as before.
2. `GET /api/search/suggest?q=`.
3. `useDebounce(value, 150)` hook, plus an effect that fetches with an `AbortController`.
4. `SearchBar` with a dropdown, bolded matched substring, `↑ ↓ Enter Esc` and an empty state.

**Checkpoint:** typing "dict" shows dictionaries, defaultdict and the cheat sheet, and works with the keyboard alone.

### Phase 4: Cheat sheets + diagrams + About
1. Copy `cheatsheets.py` + JSON and add the two endpoints.
2. `CheatSheetsPage` (list) and `CheatSheetPage` (sections → table rows).
3. `DiagramPlayer` component (prev/next, caption, step dots). Move the images to `public/diagrams/`.
4. Port the About page content.

**Checkpoint:** feature parity for all logged-out, read-only content.

### Phase 5: Auth + guest mode
1. Copy `models.py`, `migrations/`, `reset_tokens.py` and `mailer.py`. Set up Flask-SQLAlchemy and Flask-Migrate in `create_app()`.
2. Auth endpoints from §2.4. Keep **Flask-Login cookie sessions**: with the Vite proxy (dev) and
   same-origin serving (prod), the cookie is sent automatically. Do **not** store a JWT in
   `localStorage`, because any XSS can read it. Set `SESSION_COOKIE_HTTPONLY=True`,
   `SESSION_COOKIE_SAMESITE="Lax"`, and `SESSION_COOKIE_SECURE=True` in prod.
3. Return 401 JSON instead of redirecting. Configure `login_manager.unauthorized_handler`
   so `@login_required` returns `{"error": "..."}` with status 401 and no HTML redirect.
4. `AuthContext`: on app load, call `/api/auth/me` and expose `{status, user, login, logout, startGuest}`.
5. `LoginPage`, `SignupPage`, `ForgotPasswordPage`, `ResetPasswordPage` (reads `?token=` via `useSearchParams`).
6. `<RequireAuth>` route wrapper for `/profile`.
7. Guest mode: keep it server-side like the old app (the session flag), so the tutor rate limit
   still works. **Improvement idea:** store guest progress in `localStorage`, then POST it to
   the server right after signup so guests don't lose what they did.

**Checkpoint:** sign up, log out, log in, reset password, try a guest session. The old pytest auth tests pass, adapted to JSON.

### Phase 6: Progress + profile
1. `GET /api/progress`, `POST /api/progress/view` and `POST /api/progress/complete` (keep the slug validation).
2. `useProgress()` hook. `LessonPage` posts `view` on mount. `ChallengeRunner` posts `complete` when all tests pass.
3. Eyeball and check icons in `TopicGrid` and the sidebar.
4. Copy `profile_data.py` + tests, add `GET /api/profile`, and build `Heatmap.tsx` as a CSS grid of week rows.
   Add prev/next month buttons. The old code was already designed for `?year=&month=`.

**Checkpoint:** full parity with the old app, minus the AI tutor.

### Phase 7: Tests, CI, deploy
1. Backend: move the `tests/` folder and point the CI workflow at `back-end/`.
2. Frontend: Vitest + React Testing Library. Good first tests are `useDebounce`, `SearchBar`
   keyboard navigation, and `ChallengeRunner` with a mocked Pyodide.
3. Add a frontend CI job: `npm ci && npm run lint && npm run build && npm test`.
4. **Deploy, simplest option:** `npm run build` outputs `front-end/dist/`. Flask serves those
   static files, plus a catch-all route that returns `index.html` for any non-`/api` path,
   so deep links like `/lesson/stack` work on refresh. That gives you one server, one origin
   and no CORS. It runs on Replit like before.

---

## 5. Data and content: move once, then keep one source of truth

- Content (`lessons/*.md`, `cheatsheets/*.json`, `challenges_data.py`) lives **only in `back-end/content/`**.
  Don't duplicate it into the frontend.
- *(Optional, later)* Convert `challenges_data.py` into one JSON file per slug, like the cheat sheets.
  Then adding content never touches Python code.
- The database schema is unchanged, so you can point LearnPy2 at the **same Postgres** and existing
  users and progress carry over. If you'd rather start fresh for "real users", run the migrations on a new DB.

---

## 6. The AI tutor: decide deliberately

"No AI" applies to how the code gets written, so the product can still have a tutor. The old app paid
for Claude out of my own pocket, though. LearnPy2 should cost **$0**, so see **§10** for free ways to
power the tutor. Whatever you choose, build the tutor **last** (Phase 8):
- Copy `generator.py` + `stream_utils.py` and port `/generate/stream` to `GET /api/tutor/stream`.
  It's already SSE and already emits JSON events (`text`, `meta`, `redirect`, `error`, `[DONE]`).
- In React, a `useLessonStream(prompt)` hook opens an `EventSource`, appends `text` chunks to
  state, and calls `navigate()` on a `redirect` event. Close the `EventSource` in the effect cleanup.
- Keep the guest rate limit. Note it's in-memory, so it resets on restart and breaks with
  multiple server processes. Fine for now, but know the limitation.

---

## 7. Suggested order of learning (if a phase feels hard)

1. React basics: components, props, `useState`, lists/keys → **Phase 1**
2. `useEffect` + fetching + cleanup → **Phases 1 and 3**
3. React Router → **Phase 1**
4. Context → **Phases 1 and 5**
5. Custom hooks → **Phases 2, 3 and 6**
6. Forms + controlled inputs → **Phase 5**
7. Testing with Vitest/RTL → **Phase 7**

Official docs worth reading in order: react.dev "Learn" (all of it), react-router's
"Framework vs Library" quickstart (use **library/declarative mode**), and the Vite "Server Options → proxy" page.

---

## 8. Parity checklist (tick these off before calling the migration done)

- [ ] All ~58 lessons render with code highlighting and related chips
- [ ] Parent topics show child grids
- [ ] All challenges run in-browser and per-test results display
- [ ] Cmd/Ctrl+Enter runs, Reset restores starter code
- [ ] Autocomplete: debounce, bold match, ↑↓ Enter Esc, empty state
- [ ] Cheat sheets list and detail pages
- [ ] Diagram players on hash-map and linked-list lessons
- [ ] Signup / login / logout / forgot / reset password
- [ ] Guest mode: can learn, can't save, prompted to sign up on save
- [ ] Viewed and completed icons, persistent challenge-complete badge
- [ ] Profile heatmap + streak stats + month navigation
- [ ] Every API error is JSON. No HTML error pages reach `fetch()`
- [ ] Deep links work on hard refresh in production
- [ ] Backend and frontend tests run in CI
- [ ] (Optional) AI tutor streaming with front-door redirect and guest rate limit

---

## 9. Getting-started checklist (do these before writing any features)

Work through these in order. Each one is small. Ask Claude to review after the ones marked 🔍.

**Repo hygiene**
1. [ ] Delete the stray `.DS_Store` from the repo, and add `.DS_Store` to a root `.gitignore` (along with `__pycache__/`, `.venv/`, `.env`, `instance/`, `node_modules/`, `dist/`).
2. [ ] Replace the default Vite `front-end/README.md` and write a short root `README.md`: what LearnPy2 is, the stack, how to run it.
3. [ ] Rename `"name": "my-app"` in `front-end/package.json` to `"learnpy2-frontend"`.
4. [ ] Start working on feature branches + PRs instead of committing to `main`. It gives Claude a clean diff to review. 🔍

**Decisions to write down (one paragraph each, in `docs/DECISIONS.md`)**
5. [ ] Backend: Flask JSON API (recommended in §2.1). Confirm or change.
6. [ ] Styling approach: plain CSS (what Navbar.css uses), CSS modules, or Tailwind. Pick **one**.
7. [ ] Database: fresh Postgres for LearnPy2, or reuse the old one (§5).
8. [ ] AI tutor: which free option from §10 (or none for v1).

**Frontend foundation**
9. [ ] Clean up the starter Navbar: remove the unused `logonav` function and `React` import, fix `/Lessons` → `/lessons`. 🔍
10. [ ] Install `react-router` and set up the route table in `App.tsx` with placeholder pages (each page just shows its name). 🔍
11. [ ] Switch navbar `<a href>` to `<Link to>` and confirm clicking doesn't reload the page.
12. [ ] Create `src/api/client.ts` (fetch wrapper) and `src/api/types.ts`. 🔍

**Backend foundation**
13. [ ] Create `back-end/` with a virtualenv, `requirements.txt` and `app.py` using a `create_app()` factory.
14. [ ] Add `GET /api/health` and the JSON error handler. 🔍
15. [ ] Add the Vite proxy (`/api` → `localhost:5000`). Show the health response on the home page. **= Phase 0 checkpoint.**
16. [ ] Replace or delete the root `main.py` once `back-end/app.py` exists.

**Safety net**
17. [ ] Add a GitHub Actions workflow that runs `npm run lint && npm run build` for the frontend and `pytest` for the backend, even with zero tests. It catches breakage from day one.
18. [ ] Write the API contract (§2.4) into `docs/API.md` and treat it as the source of truth. 🔍

Once 1–18 are done, start **Phase 1** (§4).

---

## 10. Running the AI tutor for $0

The old app called Claude with my own API key, so every lesson generated cost me money. Options that cost nothing:

| Option | How it works | Cost to me | Downsides |
|---|---|---|---|
| **A. No live AI (v1 default)** | Catalog + FTS search only. Off-catalog queries show "no lesson yet" and the closest matches | $0 | Off-catalog questions get no custom answer |
| **B. Bring your own key (BYOK)** | Users paste *their own* API key in Settings, and requests use their key | $0 | Most beginners don't have a key. Handling other people's keys needs care (see below) |
| **C. Hosted free tiers** | Google Gemini API, Groq, OpenRouter's `:free` models, Cloudflare Workers AI, GitHub Models | $0 within limits | Rate limits (per minute and per day). Terms change without notice. Some free tiers may use prompts for training. GitHub Models is meant for prototyping, not production |
| **D. AI in the browser** | WebLLM or Transformers.js runs a small open model on the user's GPU via WebGPU | $0 (the user's device does the work) | First load downloads roughly 1 GB or more. Needs a recent browser with WebGPU. Small models give weaker answers |
| **E. Local model for development** | Ollama on your own machine | $0 | Only works on your computer. Hosting it for real users needs a paid GPU server, so it doesn't count as free |

> Free-tier details (limits, data-use terms, which models are free) change often. Check each provider's
> current pricing and terms page before you build against it.

**Recommended path:**
1. **Ship v1 with Option A.** The hand-authored catalog is the product, and you avoid any dependency on someone else's free tier.
2. **Design for swapping.** In `back-end/tutor/`, define one small interface (e.g. `stream_lesson(prompt) -> iterator of events`)
   with one class per provider. The rest of the app never knows which provider is active, and a config value picks it.
   This is a good architecture exercise in itself.
3. **Then add Option C** (one free-tier provider) with strict limits: login required, a per-user daily cap,
   and caching of answers to repeated questions in the existing `Generation` table so the same question never costs a second call.
   When the provider returns a rate-limit error, fall back to Option A's "closest matches" view instead of an error page.
4. **Optionally add Option B** as a "power user" setting. If you do, never log keys, never store them in your database,
   and keep them only in the user's browser. Note that calling a provider directly from the browser exposes the key to that page's JavaScript.
   That's acceptable only because it's the user's own key in their own browser.
5. **Option D** is a fun stretch project, not a v1 dependency.
