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

export function matchRuleByUrl(url: string, rules: MockRule[]): MockRule | null {
	for (const rule of rules) {
		if (rule.match(url)) return rule;
	}
	return null;
}
