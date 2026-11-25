#include <pebble.h>
#include <stdint.h>

// Expose the watch's Text Size preference to JavaScript. 0 = small,
// 1 = medium, 2 = large, 3 = extra large.
int32_t slide_content_size(void) {
  return (int32_t)preferred_content_size();
}

/*
 * Native ActionMenu.
 *
 * FFI calls in this build are one-way, so the menu writes the selected action
 * into a static result. PKJS polls it with a short timer while the menu is
 * open. 0 means still open, -1 means closed without a selection.
 */

// Keep these values in sync with ACTION in src/embeddedjs/main.js.
enum {
  ACTION_UNDO = 1,
  ACTION_METRIC,
  ACTION_IMPERIAL,
  ACTION_VIBE_ON,
  ACTION_VIBE_OFF,
};

// Keep these bits in sync with the flags built by openActionMenu() in main.js.
enum {
  FLAG_IMPERIAL = 1,
  FLAG_VIBE_OFF = 2,
};

extern Window *slide_app_window;

static ActionMenu *s_menu = NULL;
static ActionMenuLevel *s_root = NULL;
static volatile int32_t s_result = 0;

static void action_menu_perform(ActionMenu *menu, const ActionMenuItem *item, void *context) {
  s_result = (int32_t)(intptr_t)action_menu_item_get_action_data(item);
}

static void action_menu_closed(ActionMenu *menu, const ActionMenuItem *item, void *context) {
  if (s_root) {
    action_menu_hierarchy_destroy(s_root, NULL, NULL);
    s_root = NULL;
  }
  s_menu = NULL;
  if (s_result == 0)
    s_result = -1;
  if (slide_app_window)
    layer_mark_dirty(window_get_root_layer(slide_app_window));
}

int32_t slide_action_menu_open(int32_t flags, uint32_t accent) {
  if (s_menu)
    return 0;

  s_result = 0;
  s_root = action_menu_level_create(3);
  ActionMenuLevel *units = action_menu_level_create(2);
  ActionMenuLevel *vibration = action_menu_level_create(2);
  if (!s_root || !units || !vibration) {
    if (s_root)
      action_menu_hierarchy_destroy(s_root, NULL, NULL);
    if (units)
      action_menu_hierarchy_destroy(units, NULL, NULL);
    if (vibration)
      action_menu_hierarchy_destroy(vibration, NULL, NULL);
    s_root = NULL;
    s_result = -1;
    return 0;
  }

  if (flags & FLAG_IMPERIAL) {
    action_menu_level_add_action(units, "Imperial",
      action_menu_perform, (void *)(intptr_t)ACTION_IMPERIAL);
    action_menu_level_add_action(units, "Metric",
      action_menu_perform, (void *)(intptr_t)ACTION_METRIC);
  }
  else {
    action_menu_level_add_action(units, "Metric",
      action_menu_perform, (void *)(intptr_t)ACTION_METRIC);
    action_menu_level_add_action(units, "Imperial",
      action_menu_perform, (void *)(intptr_t)ACTION_IMPERIAL);
  }
  action_menu_level_add_child(s_root, units,
    (flags & FLAG_IMPERIAL) ? "Units: Imperial" : "Units: Metric");

  if (flags & FLAG_VIBE_OFF) {
    action_menu_level_add_action(vibration, "Off",
      action_menu_perform, (void *)(intptr_t)ACTION_VIBE_OFF);
    action_menu_level_add_action(vibration, "On",
      action_menu_perform, (void *)(intptr_t)ACTION_VIBE_ON);
  }
  else {
    action_menu_level_add_action(vibration, "On",
      action_menu_perform, (void *)(intptr_t)ACTION_VIBE_ON);
    action_menu_level_add_action(vibration, "Off",
      action_menu_perform, (void *)(intptr_t)ACTION_VIBE_OFF);
  }
  action_menu_level_add_child(s_root, vibration,
    (flags & FLAG_VIBE_OFF) ? "Vibration: Off" : "Vibration: On");

  // Destructive action last, away from the settings submenus.
  action_menu_level_add_action(s_root, "Undo Last Lift",
    action_menu_perform, (void *)(intptr_t)ACTION_UNDO);

  ActionMenuConfig config = {
    .root_level = s_root,
    .context = NULL,
    .colors = {
      .background = GColorFromHEX(accent),
      .foreground = GColorWhite,
    },
    .did_close = action_menu_closed,
    .align = ActionMenuAlignTop,
  };

  s_menu = action_menu_open(&config);
  if (s_menu && slide_app_window)
    action_menu_set_result_window(s_menu, slide_app_window);
  if (!s_menu) {
    if (s_root)
      action_menu_hierarchy_destroy(s_root, NULL, NULL);
    s_root = NULL;
    s_result = -1;
    return 0;
  }
  return 1;
}

int32_t slide_action_menu_result(void) {
  return s_result;
}

void slide_action_menu_close(void) {
  if (!s_menu)
    return;
  ActionMenu *menu = s_menu;
  s_menu = NULL;
  action_menu_close(menu, false);
  if (s_result == 0)
    s_result = -1;
}
