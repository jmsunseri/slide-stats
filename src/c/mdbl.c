#include <pebble.h>

int main(void) {
  Window *w = window_create();
  window_stack_push(w, true);

  // Poco plus the app modules need more than the default 32 kB engine pool.
  // The archive is loaded into RAM, so the XS pools and fxMapArchive's
  // temporary symbol/map tables all share the app heap. Adding coordinates
  // previously moved 1 kB from the stack and 2 kB from chunks into slots.
  // The slot pool is now reduced from 48,640 to 47,616 as a startup-budget
  // experiment; keep stack and chunk unchanged. 46,848 and below failed with
  // `memory full` in the emulator, so 47,616 is the tested safe reduction.
  // `npm run check-memory` is the guardrail.
  ModdableCreationRecord cr = {
    .recordSize = sizeof(cr),
    .stack = 5120,
    .slot = 47616,
    .chunk = 26624,
#ifdef PBL_DEBUG
    .flags = kModdableCreationFlagDebug | kModdableCreationFlagLogInstrumentation,
#endif
    .fxBuildFFI = fxBuildFFI,
  };
  moddable_createMachine(&cr);

  window_destroy(w);
}
