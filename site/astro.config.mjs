// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseLinks from './src/plugins/rehype-base-links.mjs';

const REPO = 'https://github.com/sundharesan11/devtwin';
// Served by GitHub Pages at https://sundharesan11.github.io/devtwin/.
// Override with SITE_URL / SITE_BASE (for example a custom domain with base "/").
const SITE = process.env.SITE_URL ?? 'https://sundharesan11.github.io';
const BASE = process.env.SITE_BASE ?? '/devtwin';

export default defineConfig({
	site: SITE,
	base: BASE,
	markdown: {
		rehypePlugins: [[rehypeBaseLinks, { base: BASE }]],
	},
	integrations: [
		starlight({
			title: 'devtwin',
			description:
				'devtwin is an open-source, local-first CLI and harness that carries your project context, decisions and accounts into every coding-agent session.',
			logo: { src: './src/assets/logo.svg', alt: '' },
			social: [{ icon: 'github', label: 'GitHub', href: REPO }],
			editLink: { baseUrl: `${REPO}/edit/main/site/` },
			lastUpdated: false,
			customCss: [
				'@fontsource/inter/400.css',
				'@fontsource/inter/500.css',
				'@fontsource/inter/600.css',
				'@fontsource/inter-tight/500.css',
				'@fontsource/inter-tight/600.css',
				'@fontsource/inter-tight/700.css',
				'@fontsource/jetbrains-mono/400.css',
				'@fontsource/jetbrains-mono/500.css',
				'./src/styles/starlight.css',
			],
			components: {
				ThemeProvider: './src/components/docs/ThemeProvider.astro',
				SocialIcons: './src/components/docs/SocialIcons.astro',
			},
			sidebar: [
				{
					label: 'Start here',
					items: [
						{ slug: 'docs', label: 'Introduction' },
						'docs/getting-started/installation',
						'docs/getting-started/quickstart',
					],
				},
				{
					label: 'Concepts',
					items: [
						'docs/concepts/how-it-works',
						'docs/concepts/records',
						'docs/concepts/briefs',
						'docs/concepts/scopes-and-projects',
						'docs/concepts/handoffs',
						'docs/concepts/where-data-lives',
					],
				},
				{
					label: 'Guides',
					items: [
						'docs/guides/onboard-a-repository',
						'docs/guides/capture-decisions',
						'docs/guides/coding-agents',
						'docs/guides/personal-harness',
						'docs/guides/stack-watch',
						'docs/guides/live-mode',
						'docs/guides/migrate-from-devctx',
						'docs/guides/identity-routing',
						'docs/guides/skill-sources',
					],
				},
				{
					label: 'Reference',
					items: [
						'docs/reference/cli',
						'docs/reference/configuration',
						'docs/reference/bundled-skills',
						'docs/reference/errors',
					],
				},
				{
					label: 'Security',
					items: ['docs/security/security-model', 'docs/security/limitations'],
				},
				{
					label: 'Project',
					items: ['docs/project/contributing', 'docs/project/roadmap'],
				},
				{
					label: 'Ask DeepWiki',
					link: 'https://deepwiki.com/sundharesan11/devtwin',
					attrs: { target: '_blank', rel: 'noopener' },
				},
			],
		}),
	],
});
