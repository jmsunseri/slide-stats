/*
 * Clay tabs for the phone page.
 *
 * Clay has no built-in tabs. This component renders a sticky tab bar and a
 * custom function shows/hides grouped config items. The approach follows the
 * MIT-licensed tabs component in stefanopace/AntiGrav.
 */

/* The component and custom function are serialized into the config page, so
 * they must stay self-contained: no references to module-level values. */

const tabsComponent = {
	name: "tabs",
	template: '<div class="component component-tabs"><div class="tabs-bar"></div></div>',
	style: [
		".component.component-tabs {",
		"  position: sticky;",
		"  top: 0;",
		"  z-index: 20;",
		"  background: #333333;",
		"  margin-left: -0.75rem;",
		"  margin-right: -0.75rem;",
		"  padding: 0.55rem 0.55rem 0.65rem;",
		"}",
		".component-tabs .tabs-bar {",
		"  display: flex;",
		"}",
		".component-tabs .tabs-bar button {",
		"  flex: 1;",
		"  margin: 0.2rem;",
		"  border: 0;",
		"  border-radius: 0.25rem;",
		"  background: #414141;",
		"  color: #ffffff;",
		"  font: inherit;",
		"  font-size: 0.78rem;",
		"  letter-spacing: 0.03em;",
		"  text-transform: uppercase;",
		"  padding: 0.55rem 0.35rem;",
		"}",
		".component-tabs .tabs-bar button.active {",
		"  background: #ff4700;",
		"}",
	].join("\n"),
	manipulator: {
		get: function () {
			return this.$element[0].getAttribute("data-tab") || "";
		},
		set: function (value) {
			var next = value == null || value === "" ? (this.config.defaultValue || "") : String(value);
			var root = this.$element[0];
			if (root.getAttribute("data-tab") === next)
				return this;
			root.setAttribute("data-tab", next);
			var buttons = root.querySelectorAll("button");
			for (var i = 0; i < buttons.length; i++) {
				if (buttons[i].getAttribute("data-tab") === next)
					buttons[i].classList.add("active");
				else
					buttons[i].classList.remove("active");
			}
			return this.trigger("change");
		},
	},
	defaults: {
		options: [],
		defaultValue: "",
	},
	initialize: function () {
		var root = this.$element[0].querySelector(".tabs-bar");
		var options = this.config.options || [];
		var self = this;
		for (var i = 0; i < options.length; i++) {
			(function (option) {
				var button = document.createElement("button");
				button.type = "button";
				button.textContent = option.label;
				button.setAttribute("data-tab", option.value);
				button.addEventListener("click", function () {
					self.set(option.value);
				});
				root.appendChild(button);
			})(options[i]);
		}
	},
};

function clayTabsCustomFn() {
	var clayConfig = this;

	function syncSections() {
		var sections = document.querySelectorAll(".section");
		for (var i = 0; i < sections.length; i++) {
			var section = sections[i];
			var visible = false;
			for (var j = 0; j < section.children.length; j++) {
				if (!section.children[j].classList.contains("hide")) {
					visible = true;
					break;
				}
			}
			section.classList[visible ? "remove" : "add"]("hide");
		}
	}

	function clearDataSelections(exceptGroup) {
		var items = clayConfig.getAllItems();
		for (var i = 0; i < items.length; i++) {
			var group = items[i].config.group;
			if (!group || group.indexOf("data:") !== 0)
				continue;
			if (items[i].config.type !== "checkboxgroup")
				continue;
			if (group === exceptGroup)
				continue;
			items[i].set([]);
		}
	}

	function applyVisibility() {
		var tabs = clayConfig.getItemById("page-tabs");
		var tab = tabs ? tabs.get() : "settings";
		var picker = clayConfig.getItemById("season-picker");
		var season = picker ? picker.get() : "";
		var manage = clayConfig.getItemById("manage-data");
		var managing = manage ? manage.get() : false;
		var items = clayConfig.getAllItems();
		for (var i = 0; i < items.length; i++) {
			var group = items[i].config.group;
			if (!group)
				continue;
			var visible;
			if (group === "settings")
				visible = tab === "settings";
			else if (group === "stats")
				visible = tab === "stats";
			else if (group.indexOf("season:") === 0)
				visible = tab === "stats" && group === "season:" + season;
			else if (group.indexOf("data:") === 0)
				visible = tab === "stats" && managing && group === "data:" + season;
			else
				visible = true;
			if (visible)
				items[i].show();
			else
				items[i].hide();
		}
		clearDataSelections(tab === "stats" && managing ? "data:" + season : "");
		syncSections();
	}

	clayConfig.on(clayConfig.EVENTS.AFTER_BUILD, function () {
		var tabs = clayConfig.getItemById("page-tabs");
		var picker = clayConfig.getItemById("season-picker");
		applyVisibility();
		if (tabs) {
			tabs.on("change", function () {
				applyVisibility();
				window.scrollTo(0, 0);
			});
		}
		if (picker) {
			picker.on("change", function () {
				applyVisibility();
				window.scrollTo(0, 0);
			});
		}
		var manage = clayConfig.getItemById("manage-data");
		if (manage) {
			manage.on("change", function () {
				applyVisibility();
			});
		}
		var submits = clayConfig.getItemsByType("submit");
		for (var s = 0; s < submits.length; s++) {
			(function (submit) {
				var id = submit.config.id;
				if (!id || id.indexOf("purge-submit-") !== 0)
					return;
				submit.on("click", function (event) {
					var group = submit.config.group;
					var list = null;
					var items = clayConfig.getAllItems();
					for (var i = 0; i < items.length; i++) {
						if (items[i].config.group === group && items[i].config.type === "checkboxgroup")
							list = items[i];
					}
					var selected = 0;
					if (list) {
						var checked = list.get();
						for (var j = 0; j < checked.length; j++) {
							if (checked[j])
								selected++;
						}
					}
					if (!selected) {
						event.preventDefault();
						window.alert("Select at least one day to delete.");
					}
					else if (!window.confirm("Delete " + selected + (selected === 1 ? " day" : " days") + "? This cannot be undone."))
						event.preventDefault();
				});
			})(submits[s]);
		}
	});
}

module.exports = { tabsComponent, clayTabsCustomFn };
