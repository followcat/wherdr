// Install of an on-device model: the server fetches the model's files (and the
// runtime) into DATA_DIR/models when it lacks them, then the phone downloads
// them from /models/**. Called again to follow the progress. `{ voice }` does
// the same for a read-aloud voice.
export default defineApi((_event, b) => serverFiles.prepare(String(b?.voice ?? b?.model ?? '')))
