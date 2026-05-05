const DEFAULT_TERMINAL_COLUMNS = 72;
const MIN_BOX_WIDTH = 12;
const MAX_BOX_WIDTH = 96;
const DEFAULT_LABEL_WIDTH = 8;
const RESET = "\x1b[0m";
const DIM_CYAN = "\x1b[36;2m";
const BOLD_CYAN = "\x1b[36;1m";
const SOFT_GREEN = "\x1b[32m";
const SOFT_AMBER = "\x1b[33m";

export type VisibilityBoxOptions = {
	columns?: number;
	color?: boolean;
	labelWidth?: number;
	maxWidth?: number;
};

export type VisibilityBoxRow = [label: string, value: string];

export function visibilityBoxSentinel(title: string): string {
	return `╭─ ${title.split(/\s+/)[0]}`;
}

function clip(value: string, width: number): string {
	if (width <= 0) return "";
	return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
}

function terminalColumns(): number {
	const envColumns = Number.parseInt(process.env.COLUMNS ?? "", 10);
	return process.stdout.columns || (Number.isFinite(envColumns) ? envColumns : DEFAULT_TERMINAL_COLUMNS);
}

function boxWidth(columns: number | undefined, maxWidth = MAX_BOX_WIDTH): number {
	return Math.min(maxWidth, Math.max(MIN_BOX_WIDTH, (columns ?? terminalColumns()) - 2));
}

function supportsColor(color: boolean | undefined): boolean {
	return color === true;
}

function paint(value: string, code: string, color: boolean): string {
	return color ? `${code}${value}${RESET}` : value;
}

function boxRow(label: string, value: string, innerWidth: number, labelWidth: number, color: boolean): string {
	const labelText = clip(label, labelWidth).padEnd(labelWidth);
	const valueWidth = Math.max(0, innerWidth - labelWidth - 2);
	const valueText = clip(value, valueWidth);
	const padding = " ".repeat(Math.max(0, innerWidth - labelWidth - valueText.length - 2));
	const valueColor = label === "memory" || label === "write" ? SOFT_AMBER : SOFT_GREEN;
	return [
		paint("│", DIM_CYAN, color),
		" ",
		paint(labelText, BOLD_CYAN, color),
		" ",
		paint(valueText, valueColor, color),
		padding,
		paint("│", DIM_CYAN, color),
	].join("");
}

export function formatVisibilityBox(titleText: string, rows: VisibilityBoxRow[], options: VisibilityBoxOptions = {}): string {
	const innerWidth = Math.max(0, boxWidth(options.columns, options.maxWidth) - 2);
	const labelWidth = options.labelWidth ?? DEFAULT_LABEL_WIDTH;
	const color = supportsColor(options.color);
	const title = clip(`─ ${titleText} `, innerWidth);
	const top = `╭${title}${"─".repeat(Math.max(0, innerWidth - title.length))}╮`;
	return [
		paint(top, DIM_CYAN, color),
		...rows.map(([label, value]) => boxRow(label, value, innerWidth, labelWidth, color)),
		paint(`╰${"─".repeat(innerWidth)}╯`, DIM_CYAN, color),
	].join("\n");
}
