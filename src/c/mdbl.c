#include <pebble.h>

int main(void) {
  Window *w = window_create();
  window_stack_push(w, true);

  // Poco plus the app modules need more than the default 32 kB engine pool.
  // The archive is loaded into RAM, so the XS pools and fxMapArchive's
  // temporary symbol/map tables all share the ~122 kB app heap. This split is
  // the tested working point; remeasure before growing the watch-side bundle.
  ModdableCreationRecord cr = {
    .recordSize = sizeof(cr),
    .stack = 6144,
    .slot = 45568,
    .chunk = 28672,
#ifdef PBL_DEBUG
    .flags = kModdableCreationFlagDebug,
#endif
    .fxBuildFFI = fxBuildFFI,
  };
  moddable_createMachine(&cr);

  window_destroy(w);
}
