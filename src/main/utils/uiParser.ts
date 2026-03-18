export interface UiElement {
  text: string;
  className: string;
  package: string;
  resourceId: string;
  contentDesc: string;
  bounds: [number, number, number, number]; // [x1, y1, x2, y2]
  clickable: boolean;
  scrollable: boolean;
}

/** uiautomator dump XML → UiElement[] */
export function parseUiDump(xml: string): UiElement[] {
  const elements: UiElement[] = [];
  const nodeRegex = /<node[^>]+>/g;
  let match: RegExpExecArray | null;

  while ((match = nodeRegex.exec(xml)) !== null) {
    const node = match[0];

    const text = extractAttr(node, 'text');
    const contentDesc = extractAttr(node, 'content-desc');
    if (!text && !contentDesc) continue; // 텍스트 없는 노드 스킵

    const boundsStr = extractAttr(node, 'bounds');
    const boundsMatch = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!boundsMatch) continue;

    elements.push({
      text,
      className: extractAttr(node, 'class'),
      package: extractAttr(node, 'package'),
      resourceId: extractAttr(node, 'resource-id'),
      contentDesc,
      bounds: [
        parseInt(boundsMatch[1]),
        parseInt(boundsMatch[2]),
        parseInt(boundsMatch[3]),
        parseInt(boundsMatch[4]),
      ],
      clickable: extractAttr(node, 'clickable') === 'true',
      scrollable: extractAttr(node, 'scrollable') === 'true',
    });
  }

  return elements;
}

/** 텍스트로 요소 검색 (정확 → 부분 매칭) */
export function findByText(elements: UiElement[], text: string): UiElement | null {
  return elements.find(e => e.text === text || e.contentDesc === text)
    || elements.find(e => e.text.includes(text) || e.contentDesc.includes(text))
    || null;
}

/** bounds 중심점 계산 */
export function getCenterPoint(bounds: [number, number, number, number]): { x: number; y: number } {
  return {
    x: Math.round((bounds[0] + bounds[2]) / 2),
    y: Math.round((bounds[1] + bounds[3]) / 2),
  };
}

function extractAttr(node: string, attr: string): string {
  const regex = new RegExp(`${attr}="([^"]*)"`, 'i');
  const match = node.match(regex);
  return match ? decodeXmlEntities(match[1]) : '';
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, '\n')
    .replace(/&#13;/g, '\r');
}
