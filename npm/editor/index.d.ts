/**
 * @rhwp/editor — HWP 에디터 웹 컴포넌트
 */

export interface EditorOptions {
  /** rhwp-studio URL (기본: https://edwardkim.github.io/rhwp/) */
  studioUrl?: string;
  /** iframe 너비 (기본: '100%') */
  width?: string;
  /** iframe 높이 (기본: '100%') */
  height?: string;
}

export interface LoadResult {
  pageCount: number;
}

export type EditorOperation =
  | { type: 'insertAtCursor'; text: string }
  | { type: 'replaceSelectionOrInsert'; text: string }
  | { type: 'selectTarget'; target: { kind: 'paragraph'; sectionIndex: number; paragraphIndex: number }; mode?: 'cursor' | 'text' };

export interface DocumentPosition {
  sectionIndex: number;
  paragraphIndex: number;
  charOffset: number;
  parentParaIndex?: number;
  controlIndex?: number;
  cellIndex?: number;
  cellParaIndex?: number;
  cellPath?: Array<{ controlIndex: number; cellIndex: number; cellParaIndex: number }>;
}

export interface SelectionContext {
  documentRevision: number;
  hasSelection: boolean;
  selection: { start: DocumentPosition; end: DocumentPosition } | null;
  selectedText: string;
  selectedHtml: string;
  pageIndex: number;
}

export declare class RhwpEditor {
  /** HWP 파일을 로드합니다 */
  loadFile(
    data: ArrayBuffer | Uint8Array,
    fileName?: string,
    options?: { validationChoice?: 'prompt' | 'as-is'; readOnly?: boolean },
  ): Promise<LoadResult>;
  /** 빈 HWP 문서를 생성합니다. exportHwpx()로 HWPX를 내보낼 수 있습니다. */
  createNewDocument(): Promise<LoadResult>;
  /** 명시적으로 생성한 문서의 초기 내용 또는 확인된 편집 작업을 적용합니다. */
  applyAiOperations(operations: EditorOperation[]): Promise<{ ok: boolean; context: SelectionContext }>;
  /** 현재 문서의 페이지 수를 반환합니다 */
  pageCount(): Promise<number>;
  /** 특정 페이지를 SVG 문자열로 렌더링합니다 */
  getPageSvg(page?: number): Promise<string>;
  /** 현재 선택영역의 텍스트, 위치 앵커, 문서 revision을 반환합니다. */
  getSelection(): Promise<SelectionContext>;
  /** 문서의 특정 구조 위치로 이동하거나 해당 문단을 선택합니다. */
  selectTarget(
    target: { kind: 'paragraph'; sectionIndex: number; paragraphIndex: number },
    mode?: 'cursor' | 'text',
  ): Promise<{ ok: boolean; context: SelectionContext }>;
  /** 문서 선택을 바꾸지 않고, 원문 인용 위치의 bounding box를 표시합니다. */
  highlightTarget(
    target: { kind: 'paragraph' | 'table'; sectionIndex: number; paragraphIndex: number },
  ): Promise<{ ok: boolean; context: SelectionContext }>;
  /** revision과 앵커가 일치할 때만 선택영역을 교체합니다. */
  replaceSelection(
    text: string,
    expectedRevision: number,
    expectedSelection: NonNullable<SelectionContext['selection']>,
  ): Promise<SelectionContext>;
  /** 현재 문서를 HWPX 바이트로 내보냅니다. */
  exportHwpx(): Promise<Uint8Array>;
  undo(): Promise<{ ok: boolean; context: SelectionContext }>;
  redo(): Promise<{ ok: boolean; context: SelectionContext }>;
  /** iframe 엘리먼트를 반환합니다 */
  readonly element: HTMLIFrameElement;
  /** 에디터를 제거합니다 */
  destroy(): void;
}

/**
 * HWP 에디터를 생성하여 지정된 컨테이너에 마운트합니다.
 *
 * @example
 * ```javascript
 * import { createEditor } from '@rhwp/editor';
 *
 * const editor = await createEditor('#container');
 * const resp = await fetch('document.hwp');
 * await editor.loadFile(await resp.arrayBuffer());
 * ```
 */
export declare function createEditor(
  container: string | HTMLElement,
  options?: EditorOptions,
): Promise<RhwpEditor>;
