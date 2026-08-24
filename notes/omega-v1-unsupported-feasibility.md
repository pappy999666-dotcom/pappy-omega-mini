# Omega-V1 Unsupported Features — PAPPY Implementation Feasibility

## Exact unsupported list

1. **Game API** — Omega surface: `session:<id>:gameapi`. PAPPY has no Game API provider, credential store, or session-scoped game service.
2. **AI Group / Meta AI** — Omega surface: `session:<id>:aigroup`. PAPPY has no Meta AI group workflow or transport contract.
3. **Plugins** — Omega surface: `session:<id>:plugins`. PAPPY has no plugin registry, sandbox, permission model, or lifecycle manager.
4. **Smart Promotion** — Omega surface: `session:<id>:smartpromo`. PAPPY has Auto Promote, but not Omega’s separate Smart Promotion wizard and job model.
5. **Tutorial Content** — Omega surface: `admin:tutorials`. PAPPY has no tutorial-content persistence, media preview, or delete-confirm flow.
6. **Release Controls** — Omega surface: `admin:release:menu`. PAPPY deployment is managed by the controlled release path; Telegram self-update callbacks do not exist.
7. **Menu URL Manager** — Omega surface: `admin:menuurl`. PAPPY does not persist custom Telegram menu-button URLs.
8. **Idea Inbox** — Omega surface: `admin:ideas`. PAPPY has support tickets, but no separate idea state machine, voting, or idea reply workflow.
9. **Deep member moderation dashboard** — Omega surface: `gcset:<session>:<group>`. PAPPY currently supports group metadata, picture, subject, description, invite, and leave, but not a complete safe Telegram member-moderation API.
10. **Omega bucket mutation semantics** — Omega surfaces include `bucket:merge:main` and user-scoped bucket controls. PAPPY’s centralized validator architecture intentionally prevents user-owned bucket mutation from returning.

Bridge is deliberately excluded from this list because PAPPY already has global and per-session Bridge implementations.

## Feasibility assessment

| Feature | Readiness | Reuse available | New work required | Recommendation |
|---|---|---|---|---|
| Menu URL Manager | High | Telegram callback/UI patterns; Mongo connection | Small `MenuUrl` record, admin CRUD, URL validation, menu rendering | **Best first slice**; isolated and low WhatsApp risk. |
| Idea Inbox | High | Existing `SupportTicketRecord`, `listSupportTickets`, `updateSupportTicket`, Admin Support Inbox | Add an idea discriminator/category and optional lifecycle fields; add admin/user screens | **Good first slice**; can reuse persistence and authorization. |
| Tutorial Content | Medium-high | Existing menu media upload/download, media persistence, Telegram media listeners | Tutorial record, title/category/order, admin CRUD, delivery/preview route | **Good second slice**; should reuse media storage but remain separate from WhatsApp menu media. |
| Smart Promotion | Medium | Auto Promote config/run models, scheduler, media payloads, live-job rendering | New wizard semantics and possibly target/batch/cycle fields; careful job-idempotency mapping | **Feasible after small slices**; avoid creating a second scheduler. |
| Deep member moderation | Medium-low | Baileys socket, group metadata, current moderator persistence | Capability wrappers for promote/demote/remove/approve, authorization, confirmation, audit, rate safety, tests | **Feasible but sensitive**; implement only with explicit action limits and audit logs. |
| Release Controls | Medium-low | Existing release endpoint and worker versioning | Read-only release status first; deployment authorization, rollout guard, backup/rollback | Implement **read-only status only** first. Do not add Telegram self-update/restart. |
| Game API | Low | Session ownership and Telegram menus only | Provider API, credentials, command execution, quotas, abuse controls, persistence | Not a safe next feature without a concrete provider/API contract. |
| AI Group / Meta AI | Low | Session/group selection only | Meta AI integration, credentials, transport semantics, privacy and quota handling | Not a safe next feature without a concrete API and user policy. |
| Plugins | Very low | None | Sandboxed runtime, signing, permissions, resource limits, versioning, rollback | Do not implement inside the current bot until a full security design exists. |
| Omega bucket mutation semantics | No-go under current architecture | Central Validator Hub already owns all buckets | Would violate the centralized ownership/invariant design | Do not reintroduce; preserve admin-owned centralized validation. |

## Recommended order

The safest practical order is **Menu URL Manager → Idea Inbox → Tutorial Content → read-only Release Status → Smart Promotion adaptation**. These steps mostly affect Telegram UI and persistence, not WhatsApp delivery. Deep member moderation should be a separate security-reviewed project because a mistake can remove members or change group permissions. Game API, AI Group, and Plugins should wait for explicit external contracts and a dedicated threat model.

No unsupported feature should be exposed as a button until its persistence, authorization, handler, failure path, and regression tests exist.
