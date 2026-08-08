# Graph Report - .  (2026-08-08)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 109 nodes · 217 edges · 8 communities
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 7 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `903818a1`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6

## God Nodes (most connected - your core abstractions)
1. `DB` - 10 edges
2. `authMiddleware()` - 9 edges
3. `successResponse()` - 8 edges
4. `errorResponse()` - 8 edges
5. `users` - 6 edges
6. `compilerOptions` - 6 edges
7. `scripts` - 5 edges
8. `medicalRecords` - 4 edges
9. `schedules` - 4 edges
10. `chatMessages` - 4 edges

## Surprising Connections (you probably didn't know these)
- `authMiddleware()` --calls--> `verifyToken()`  [EXTRACTED]
  src/middlewares/auth.ts → src/utils/jwt.ts

## Import Cycles
- None detected.

## Communities (8 total, 0 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.15
Nodes (14): dailyInsights, medicalRecords, schedules, api, app, port, doctorsRoute, home (+6 more)

### Community 1 - "Community 1"
Cohesion: 0.10
Nodes (20): drizzle-kit, drizzle-orm, hono, @hono/node-server, dependencies, drizzle-orm, hono, @hono/node-server (+12 more)

### Community 2 - "Community 2"
Cohesion: 0.10
Nodes (20): ChatMessage, chatMessagesRelations, DailyInsight, Doctor, doctorsRelations, MedicalRecord, medicalRecordsRelations, messageRoleEnum (+12 more)

### Community 3 - "Community 3"
Cohesion: 0.27
Nodes (11): DB, queryClient, chatMessages, doctors, users, verifRequests, authMiddleware(), AuthVariables (+3 more)

### Community 4 - "Community 4"
Cohesion: 0.31
Nodes (7): auth, JWTPayload, signAccessToken(), signRefreshToken(), generateAvatarInitials(), hashPassword(), verifyPassword()

### Community 5 - "Community 5"
Cohesion: 0.38
Nodes (9): buildUserContext(), chatWithHeally(), generateDailyInsight(), generateSchedule(), generateText(), generateTextWithImage(), getHeallySystemPrompt(), ocrMedicalDocument() (+1 more)

### Community 6 - "Community 6"
Cohesion: 0.25
Nodes (7): bun, compilerOptions, esModuleInterop, jsx, jsxImportSource, strict, types

## Knowledge Gaps
- **43 isolated node(s):** `name`, `dev`, `db:generate`, `db:push`, `db:studio` (+38 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Are the 7 inferred relationships involving `authMiddleware()` (e.g. with `routes/auth.ts` and `doctors.ts`) actually correct?**
  _`authMiddleware()` has 7 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `dev`, `db:generate` to the rest of the system?**
  _43 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.1471861471861472 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.09523809523809523 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.09523809523809523 - nodes in this community are weakly interconnected._