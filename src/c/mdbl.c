#include <pebble.h>

int main(void) {
  Window *w = window_create();
  window_stack_push(w, true);

  // Poco plus the app modules need more than the default 32 kB engine pool.
  ModdableCreationRecord cr = {
    .recordSize = sizeof(cr),
    .stack = 6144,
    .slot = 45056,
    .chunk = 28672,
#ifdef PBL_DEBUG
    .flags = kModdableCreationFlagDebug,
#endif
    .fxBuildFFI = fxBuildFFI,
  };
  moddable_createMachine(&cr);

  window_destroy(w);
}
