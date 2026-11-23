#include <pebble.h>

int main(void) {
  Window *w = window_create();
  window_stack_push(w, true);

  // Poco plus the app modules need more than the default 32 kB engine pool.
  // The archive is loaded into RAM, so the XS pools and fxMapArchive's
  // temporary symbol/map tables all share the ~122 kB app heap. Adding the
  // coordinate history pushed Gabbro's slot heap over, so this split moves
  // 1 kB from the stack and 2 kB from chunks into slots. Remeasure before
  // growing the watch-side bundle again.
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
