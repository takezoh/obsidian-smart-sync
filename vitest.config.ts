import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
	},
	resolve: {
		alias: {
			obsidian: "./src/__mocks__/obsidian.ts",
		},
	},
});
