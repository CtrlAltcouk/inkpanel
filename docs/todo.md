# To Do widget

InkPanel manages To Do lists locally. No Microsoft To Do, Todoist, Google Tasks, or other external account/API is required.

Create and edit named lists from the Dashboard editor in InkPanel Studio. A list can be selected by any number of full-size or Mini panels; each panel stores only the stable list ID, so edits immediately feed every panel that shares that list on its next frame request.

The e-paper layouts show active tasks only. Completed tasks remain available in Studio, where they can be restored or deleted. An empty active list renders an intentional **ALL DONE** state.

Lists and their ordered task items are stored in:

```text
DATA_DIR/.todo-lists.json
```

Include that file in backups alongside `DATA_DIR/config.json`. Restoring only the device configuration without `.todo-lists.json` preserves panel widget selections but not their referenced local task data.
