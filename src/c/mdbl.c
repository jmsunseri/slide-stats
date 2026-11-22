#include <pebble.h>

int main(void) {
  Window *w = window_create();
  window_stack_push(w, true);

  // Piu plus the app modules need more than the default 32 kB engine pool.
  ModdableCreationRecord cr = {
    .recordSize = sizeof(cr),
    .stack = 6144,
    .slot = 40960,
    .chunk = 24576,
#ifdef PBL_DEBUG
    .flags = kModdableCreationFlagDebug,
#endif
  };
  moddable_createMachine(&cr);

  window_destroy(w);
}
