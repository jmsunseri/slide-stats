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

	function showTab(name) {
		var items = clayConfig.getAllItems();
		for (var i = 0; i < items.length; i++) {
			var group = items[i].config.group;
			if (!group)
				continue;
			if (group === name)
				items[i].show();
			else
				items[i].hide();
		}
		syncSections();
	}

	clayConfig.on(clayConfig.EVENTS.AFTER_BUILD, function () {
		var tabs = clayConfig.getItemById("page-tabs");
		if (!tabs)
			return;
		showTab(tabs.get());
		tabs.on("change", function () {
			showTab(tabs.get());
			window.scrollTo(0, 0);
		});
	});
}

module.exports = { tabsComponent, clayTabsCustomFn };
