// Shared links for the landing page.
// TODO: confirm the GitHub org/user at release.
export const GITHUB_URL = 'https://github.com/sundharesan11/devtwin';

// Prefix a root-relative path with the configured base (e.g. /devtwin on GitHub Pages).
export const withBase = (path: string) => import.meta.env.BASE_URL.replace(/\/+$/, '') + path;

const DOC_PATHS = {
	home: '/docs/',
	installation: '/docs/getting-started/installation/',
	quickstart: '/docs/getting-started/quickstart/',
	howItWorks: '/docs/concepts/how-it-works/',
	records: '/docs/concepts/records/',
	briefs: '/docs/concepts/briefs/',
	whereDataLives: '/docs/concepts/where-data-lives/',
	codingAgents: '/docs/guides/coding-agents/',
	personalHarness: '/docs/guides/personal-harness/',
	identityRouting: '/docs/guides/identity-routing/',
	cli: '/docs/reference/cli/',
	securityModel: '/docs/security/security-model/',
	contributing: '/docs/project/contributing/',
	roadmap: '/docs/project/roadmap/',
} as const;

export const DOCS = Object.fromEntries(
	Object.entries(DOC_PATHS).map(([key, path]) => [key, withBase(path)]),
) as { [K in keyof typeof DOC_PATHS]: string };
