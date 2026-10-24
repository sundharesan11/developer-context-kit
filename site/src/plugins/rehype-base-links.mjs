// Prefixes root-relative links in Markdown/MDX content with the site base path,
// so `/docs/...` links keep working when the site is served from a subpath
// (for example GitHub Pages at /developer-context-kit/).
export default function rehypeBaseLinks({ base = '/' } = {}) {
	const prefix = base.replace(/\/+$/, '');
	const fix = (url) =>
		prefix && typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') && !url.startsWith(prefix + '/')
			? prefix + url
			: url;

	const walk = (node) => {
		if (node.type === 'element' && node.tagName === 'a' && node.properties) {
			node.properties.href = fix(node.properties.href);
		}
		// MDX components such as <LinkCard href="/docs/..." />
		if ((node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') && Array.isArray(node.attributes)) {
			for (const attr of node.attributes) {
				if (attr.type === 'mdxJsxAttribute' && attr.name === 'href') attr.value = fix(attr.value);
			}
		}
		if (Array.isArray(node.children)) node.children.forEach(walk);
	};

	return (tree) => walk(tree);
}
