# HA-5 trust and ownership boundary

The Supervisor-only listener rejects peers other than `172.30.32.2` (including its IPv4-mapped form) before identity parsing. A single parser reads the documented Ingress user headers, validates bounded/control-free values and returns safe metadata. LAN HTTP/HTTPS ignore these headers. Forwarded addresses cannot bypass the socket-address check. The documented contract is [Home Assistant App security](https://developers.home-assistant.io/docs/apps/security/).

User IDs, not names, authorize personal To Do. The strict version-1 ownership file contains only `userId`, nullable `username`/`displayName`, and unique `todoEntityIds`. A list cannot belong to two users. Mutations are serialized, validated, written to a fresh mode-0600 temporary file and atomically renamed. Invalid files are retained with a restrictive diagnostic copy; they are never silently reset. Missing users/entities revoke access rather than selecting another list. The process shares one store instance across both listeners and FrameService.

Administrative discovery/mapping endpoints remain distinct from current-user/scoped-list endpoints. The latter require a valid trusted Ingress ID and never return another user's mapping or task contents. Mapping mutations on LAN require the existing Studio authentication policy. Missing/malformed Ingress identity cannot read personal V3 panel configuration, remembered drafts or previews, push personal frames, or mutate personal configuration/ownership. Ordinary firmware frame requests on LAN do not acquire user context.

Ingress has no is-admin header. ha.12 therefore explicitly keeps `panel_admin: true`; it does not request Supervisor admin/full-access/docker/auth privileges or enumerate users. All Studio functionality—including previews and device edits—remains administrative/shared. This is an ownership foundation, not a restricted personal portal. Non-admin access needs a later route authorization, preview redaction and mutation-permission design.

V3 physical frames validate their saved owner/list before requesting tasks and recheck after the live response. Failure returns configured/unavailable with no tasks, no alternative selection and no persistent stale replay. Existing V2 HA widgets deliberately retain their historical shared behavior. Ownership metadata does not enter the pixel hash, so unchanged tasks do not cause unnecessary e-paper refreshes.

## Real installation validation

1. Upgrade to ha.12 and open the sidebar normally. Verify the iframe query and assets show `0.1.0-ha.12`; no cache clearing should be required.
2. Confirm Settings identifies the signed-in HA admin and lists only accounts previously observed through trusted Ingress. Assign one distinct personal list to each observed account. Verify another account cannot claim an already-assigned list.
3. Create a new To Do widget: Home Assistant defaults to the current owner and offers only assigned lists. Explicitly choose another known owner and check that the choices change. Save on Mini and full-size panels.
4. Open another browser/account: the saved physical owner/list must not change. Check five-task truncation, ALL DONE and unchanged appearance on both displays.
5. Load an old V2 HA widget, save an unrelated setting and verify it remains legacy shared. Use Make personal, select owner/list and save; only this explicit action creates V3.
6. Rename the same HA account and reopen Ingress: assignments persist. A different account with the same name must start with no assignments. Remove a stale mapping in Settings; this must not delete the HA account.
7. Remove/reassign an ownership mapping or remove the HA entity. The original panel must show unavailable, never another list or old tasks. Restore the assignment/entity to recover.
8. Test authenticated direct LAN Studio: current-user reports LAN with no user, admin mapping management still works, and forged user headers cannot register an account. Firmware continues polling the LAN frame endpoint normally.
9. Verify Calendar, Sensors and other widgets remain shared. Keep the sidebar admin-only; do not enable normal-user Studio access in this release.
