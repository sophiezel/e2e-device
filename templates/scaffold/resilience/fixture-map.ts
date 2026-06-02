import type { FixtureBody } from "./fixture-loader";

export interface MockRule {
	id: string;
	urlPattern: string;
	method?: string;
	body: FixtureBody;
	match: (url: string) => boolean;
}

export function getMockRulesForProfile(profile: string): MockRule[] {
	return [];
}

export function pickListRule(url: string): MockRule | null {
	return null;
}

export function pickGetByIdRule(url: string, rules: MockRule[]): MockRule | null {
	return null;
}
