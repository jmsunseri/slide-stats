#include <pebble.h>

Window *slide_app_window = NULL;

// The Poco display writes directly to the graphics context. This empty update
// proc exists so marking the app layer dirty makes the firmware restore that
// context after a native ActionMenu closes.
static void slide_window_update(Layer *layer, GContext *ctx) {
}

int main(void) {
  Window *w = window_create();
  slide_app_window = w;
  layer_set_update_proc(window_get_root_layer(w), slide_window_update);
  window_stack_push(w, true);

  // Poco plus the app modules need more than the default 32 kB engine pool.
  // The archive is loaded into RAM, so the XS pools and fxMapArchive's
  // temporary symbol/map tables all share the app heap. The phone-authoritative
  // redesign removed the watch detector and day store, which freed enough
  // archive space to restore the original slot pool. `npm run check-memory`
  // is the guardrail.
  ModdableCreationRecord cr = {
    .recordSize = sizeof(cr),
    .stack = 5120,
    .slot = 48640,
    .chunk = 26624,
#ifdef PBL_DEBUG
    .flags = kModdableCreationFlagDebug | kModdableCreationFlagLogInstrumentation,
#endif
    .fxBuildFFI = fxBuildFFI,
  };
  moddable_createMachine(&cr);

  window_destroy(w);
}
