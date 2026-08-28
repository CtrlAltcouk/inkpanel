# To Do widget

InkPanel manages To Do lists locally. No Microsoft To Do, Todoist, Google Tasks, or other external account/API is required.

Create and edit named lists from the Dashboard editor in InkPanel Studio. A list can be selected by any number of full-size or Mini panels; each panel stores only the stable list ID, so edits immediately feed every panel that shares that list on its next frame request.

The e-paper layouts show active tasks only. Completed tasks remain available in Studio, where they can be restored or deleted. An empty active list renders an intentional **ALL DONE** state.

Lists and their ordered task items are stored in:

```text
DATA_DIR/.todo-lists.json
```

Include that file in backups alongside `DATA_DIR/config.json`. Restoring only the device configuration without `.todo-lists.json` preserves panel widget selections but not their referenced local task data.

## Home Assistant personal lists (ha.12)

The Home Assistant provider is read-only in InkPanel: tasks are edited in HA. Open Studio through HA Ingress to register a user, then assign their `todo.*` lists under **Settings → Home Assistant To Do users → Manage**. Names are labels; the stable HA user ID owns assignments. Administrators can remove stale mappings without deleting HA users. Missing entities remain visible as missing/unavailable until explicitly removed or replaced.

New HA To Do widgets use V3, with `config: {provider: "home-assistant", ownerUserId: "<HA ID>", entityId: "todo.personal"}`. Choose the owner and an assigned list, then Save changes. The physical panel always uses this saved pair, independently of the browser user. Removing/reassigning ownership stops task fetches and shows the existing unavailable state. No stale task contents are persisted.

V1 local and V2 local/HA widgets remain readable and unchanged on unrelated saves. Existing V2 HA widgets are labeled **Legacy shared Home Assistant To Do**. **Make personal** explicitly starts conversion; choose an owner/list and save to persist V3. Local V3 uses `{provider: "local", listId: "..."}` and does not introduce ownership for built-in InkPanel lists.

Back up `DATA_DIR/.home-assistant-users.json` as well as panel configuration. Only HA To Do is user-scoped; Calendar, Sensors and other InkPanel data remain shared. ha.12 Studio remains HA-admin-only. Non-admin access requires a separate future permissions/redaction design.
