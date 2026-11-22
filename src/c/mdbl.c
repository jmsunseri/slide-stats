#include <pebble.h>

int main(void) {
  Window *w = window_create();
  window_stack_push(w, true);

  // Poco plus the app modules need more than the default 32 kB engine pool.
  // 45,568 is the largest slot that maps this archive; 46,080 fails.
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
