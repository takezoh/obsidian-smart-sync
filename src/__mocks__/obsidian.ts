// Minimal mock of obsidian module for testing
export const requestUrl = async (_opts: unknown): Promise<unknown> => {
	throw new Error("requestUrl not mocked for this test");
};

export class Notice {
	constructor(_message: string, _timeout?: number) {}
}

export class Modal {
	app: unknown;
	constructor(app: unknown) { this.app = app; }
	open() {}
	close() {}
	get contentEl(): HTMLElement { return document.createElement("div"); }
}

export class Setting {
	constructor(_containerEl: HTMLElement) {}
	setName(_name: string) { return this; }
	setDesc(_desc: string) { return this; }
	setHeading() { return this; }
	addButton(_cb: (b: unknown) => unknown) { return this; }
	addText(_cb: (t: unknown) => unknown) { return this; }
	addDropdown(_cb: (d: unknown) => unknown) { return this; }
	addToggle(_cb: (t: unknown) => unknown) { return this; }
	addTextArea(_cb: (t: unknown) => unknown) { return this; }
}

export const Platform = {
	isMobile: false,
	isDesktop: true,
	isDesktopApp: true,
	isMobileApp: false,
};

export class App {
	vault = { getName: () => "test-vault" };
}

export class PluginSettingTab {
	app: unknown;
	constructor(app: unknown, _plugin: unknown) { this.app = app; }
	display() {}
	get containerEl(): HTMLElement { return document.createElement("div"); }
}
