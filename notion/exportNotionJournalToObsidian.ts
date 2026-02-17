import { Client } from "@notionhq/client";
import { isFullBlock, isFullPage } from "@notionhq/client";
import type {
	BlockObjectResponse,
	PageObjectResponse,
	RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const notionApiKey = process.env.NOTION_API_KEY;
const notionDatabaseId = process.env.NOTION_DATABASE_ID;

if (!notionApiKey || !notionDatabaseId) {
	throw new Error(
		"Missing required env vars. Set NOTION_API_KEY and NOTION_DATABASE_ID.",
	);
}

const notion = new Client({ auth: notionApiKey });
const scriptDir = dirname(fileURLToPath(import.meta.url));

const normalizeText = (value: string): string => value.replace(/\r\n/g, "\n");

const toInlineMarkdown = (richText: RichTextItemResponse[]): string =>
	richText
		.map((item) => {
			const base = item.plain_text;

			if (item.type === "equation") {
				return `$${item.equation.expression}$`;
			}

			const withCode = item.annotations.code ? `\`${base}\`` : base;
			const withBold = item.annotations.bold ? `**${withCode}**` : withCode;
			const withItalic = item.annotations.italic ? `*${withBold}*` : withBold;
			const withStrike = item.annotations.strikethrough
				? `~~${withItalic}~~`
				: withItalic;
			const withUnderline = item.annotations.underline
				? `<u>${withStrike}</u>`
				: withStrike;
			const withLink = item.href
				? `[${withUnderline}](${item.href})`
				: withUnderline;

			return withLink;
		})
		.join("");

const getTitle = (page: PageObjectResponse): string => {
	const titleProp = Object.values(page.properties).find(
		(property) => property.type === "title",
	);

	if (!titleProp || titleProp.type !== "title") {
		return `Untitled-${page.id}`;
	}

	const title = toInlineMarkdown(titleProp.title).trim();

	return title.length > 0 ? title : `Untitled-${page.id}`;
};

const sanitizeFileName = (name: string): string =>
	name
		// biome-ignore lint/suspicious/noControlCharactersInRegex: <explanation>
		.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 180);

const indent = (depth: number): string => "  ".repeat(depth);

const stringifyBlock = async (
	block: BlockObjectResponse,
	depth = 0,
): Promise<string> => {
	const nested = block.has_children
		? await fetchBlocksRecursively(block.id)
		: [];
	const nestedMarkdown =
		nested.length > 0 ? `\n${await stringifyBlocks(nested, depth + 1)}` : "";

	if (block.type === "paragraph") {
		const text = toInlineMarkdown(block.paragraph.rich_text);
		return text.length > 0 ? `${indent(depth)}${text}${nestedMarkdown}` : "";
	}

	if (block.type === "heading_1") {
		return `${indent(depth)}# ${toInlineMarkdown(block.heading_1.rich_text)}`;
	}

	if (block.type === "heading_2") {
		return `${indent(depth)}## ${toInlineMarkdown(block.heading_2.rich_text)}`;
	}

	if (block.type === "heading_3") {
		return `${indent(depth)}### ${toInlineMarkdown(block.heading_3.rich_text)}`;
	}

	if (block.type === "to_do") {
		const checked = block.to_do.checked ? "x" : " ";
		return `${indent(depth)}- [${checked}] ${toInlineMarkdown(block.to_do.rich_text)}${nestedMarkdown}`;
	}

	if (block.type === "toggle") {
		return `${indent(depth)}- ${toInlineMarkdown(block.toggle.rich_text)}${nestedMarkdown}`;
	}

	if (block.type === "quote") {
		return `${indent(depth)}> ${toInlineMarkdown(block.quote.rich_text)}${nestedMarkdown}`;
	}

	if (block.type === "callout") {
		const icon =
			block.callout.icon?.type === "emoji"
				? `${block.callout.icon.emoji} `
				: "";
		return `${indent(depth)}> ${icon}${toInlineMarkdown(block.callout.rich_text)}${nestedMarkdown}`;
	}

	if (block.type === "code") {
		const language = block.code.language ?? "text";
		const body = toInlineMarkdown(block.code.rich_text);
		return `${indent(depth)}\`\`\`${language}\n${body}\n${indent(depth)}\`\`\``;
	}

	if (block.type === "divider") {
		return `${indent(depth)}---`;
	}

	if (block.type === "equation") {
		return `${indent(depth)}$$${block.equation.expression}$$`;
	}

	if (block.type === "image") {
		const imageUrl =
			block.image.type === "external"
				? block.image.external.url
				: block.image.file.url;
		const caption = toInlineMarkdown(block.image.caption);
		const alt = caption.length > 0 ? caption : "image";
		return `${indent(depth)}![${alt}](${imageUrl})`;
	}

	if (block.type === "bookmark") {
		return `${indent(depth)}[${block.bookmark.url}](${block.bookmark.url})`;
	}

	if (block.type === "file") {
		const fileUrl =
			block.file.type === "external"
				? block.file.external.url
				: block.file.file.url;
		const caption = toInlineMarkdown(block.file.caption);
		const label = caption.length > 0 ? caption : "file";
		return `${indent(depth)}[${label}](${fileUrl})`;
	}

	if (block.type === "video") {
		const videoUrl =
			block.video.type === "external"
				? block.video.external.url
				: block.video.file.url;
		return `${indent(depth)}[video](${videoUrl})`;
	}

	if (block.type === "audio") {
		const audioUrl =
			block.audio.type === "external"
				? block.audio.external.url
				: block.audio.file.url;
		return `${indent(depth)}[audio](${audioUrl})`;
	}

	if (block.type === "pdf") {
		const pdfUrl =
			block.pdf.type === "external"
				? block.pdf.external.url
				: block.pdf.file.url;
		return `${indent(depth)}[pdf](${pdfUrl})`;
	}

	if (block.type === "link_preview") {
		return `${indent(depth)}[${block.link_preview.url}](${block.link_preview.url})`;
	}

	if (block.type === "child_page") {
		return `${indent(depth)}## ${block.child_page.title}`;
	}

	if (block.type === "child_database") {
		return `${indent(depth)}## ${block.child_database.title}`;
	}

	if (block.type === "table_of_contents") {
		return `${indent(depth)}[Table of Contents]`;
	}

	if (
		block.type === "bulleted_list_item" ||
		block.type === "numbered_list_item"
	) {
		const richText =
			block.type === "bulleted_list_item"
				? block.bulleted_list_item.rich_text
				: block.numbered_list_item.rich_text;
		const label = block.type === "bulleted_list_item" ? "-" : "1.";
		return `${indent(depth)}${label} ${toInlineMarkdown(richText)}${nestedMarkdown}`;
	}

	return "";
};

const stringifyBlocks = async (
	blocks: BlockObjectResponse[],
	depth = 0,
): Promise<string> => {
	const markdownLines = await Promise.all(
		blocks.map((block) => stringifyBlock(block, depth)),
	);

	return markdownLines
		.map(normalizeText)
		.filter((line) => line.trim().length > 0)
		.join("\n\n");
};

const fetchBlocksRecursively = async (
	blockId: string,
): Promise<BlockObjectResponse[]> => {
	const fetchPage = async (
		cursor?: string,
		acc: BlockObjectResponse[] = [],
	): Promise<BlockObjectResponse[]> => {
		const response = await notion.blocks.children.list({
			block_id: blockId,
			page_size: 100,
			start_cursor: cursor,
		});

		const fullBlocks = response.results.filter(isFullBlock);
		const nextAcc = [...acc, ...fullBlocks];

		return response.has_more && response.next_cursor
			? fetchPage(response.next_cursor, nextAcc)
			: nextAcc;
	};

	return fetchPage();
};

const fetchAllPages = async (): Promise<PageObjectResponse[]> => {
	const database = await notion.databases.retrieve({
		database_id: notionDatabaseId,
	});

	if (!("data_sources" in database) || database.data_sources.length === 0) {
		throw new Error(
			`Database ${notionDatabaseId} has no data sources to query.`,
		);
	}

	const [firstDataSource] = database.data_sources;

	if (!firstDataSource) {
		throw new Error(
			`Database ${notionDatabaseId} has no queryable primary data source.`,
		);
	}

	const dataSourceId = firstDataSource.id;

	const fetchPage = async (
		cursor?: string,
		acc: PageObjectResponse[] = [],
	): Promise<PageObjectResponse[]> => {
		const response = await notion.dataSources.query({
			data_source_id: dataSourceId,
			page_size: 100,
			start_cursor: cursor,
		});

		const pages = response.results.filter(isFullPage);

		const nextAcc = [...acc, ...pages];

		return response.has_more && response.next_cursor
			? fetchPage(response.next_cursor, nextAcc)
			: nextAcc;
	};

	return fetchPage();
};

const ensureUniqueFileName = (
	desiredName: string,
	existing: Set<string>,
): string => {
	const baseName = desiredName.length > 0 ? desiredName : "Untitled";
	const candidate = `${baseName}.md`;

	if (!existing.has(candidate)) {
		existing.add(candidate);
		return candidate;
	}

	const match = Array.from({ length: 10000 }, (_, i) => i + 2).find((index) => {
		const nextCandidate = `${baseName} (${index}).md`;
		return !existing.has(nextCandidate);
	});

	if (!match) {
		throw new Error(`Could not allocate unique filename for ${baseName}`);
	}

	const unique = `${baseName} (${match}).md`;
	existing.add(unique);
	return unique;
};

const formatDate = (createdTime: string): string => createdTime.slice(0, 10);

const run = async (): Promise<void> => {
	const outputDir = join(scriptDir, "exports");
	await mkdir(outputDir, { recursive: true });

	const pages = await fetchAllPages();
	const usedNames = new Set<string>();
	const exportJobs = pages.map((page) => ({
		page,
		fileName: ensureUniqueFileName(sanitizeFileName(getTitle(page)), usedNames),
	}));

	await Promise.all(
		exportJobs.map(async ({ page, fileName }) => {
			const blocks = await fetchBlocksRecursively(page.id);
			const content = await stringifyBlocks(blocks);
			const frontmatter = `---\nWritten: ${formatDate(page.created_time)}\n---`;
			const markdown = `${frontmatter}\n\n${content}\n`;
			const targetPath = join(outputDir, fileName);

			await writeFile(targetPath, markdown, "utf8");
		}),
	);

	console.log(`Exported ${pages.length} page(s) to ${outputDir}`);
};

run().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
