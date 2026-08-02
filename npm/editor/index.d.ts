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
  | { type: 'selectTarget'; target: { kind: 'paragraph'; sectionIndex: number; paragraphIndex: number }; mode?: 'cursor' | 'text' }
  | {
      /** HTML의 문단·글자·표 서식을 실제 HWPX 구조로 가져옵니다. */
      type: 'importStyledHtml';
      html: string;
      /** 이 텍스트와 정확히 일치하는 문단 뒤에서 강제 쪽 나누기를 합니다. */
      pageBreakAfterText?: string;
      /** 각 텍스트와 정확히 일치하는 문단 앞에 저장 가능한 강제 쪽 나누기를 합니다. */
      pageBreakBeforeTexts?: string[];
      /** 장·절 제목이 다음 문단과 갈라질 때 함께 이동시킬 제목 목록. */
      headingTexts?: string[];
      /** 표지를 제외한 본문 쪽 하단에 가운데 쪽 번호를 표시한다. */
      footerPageNumbers?: boolean;
      /** 저장 가능한 쪽 나눔으로 제목과 다음 문단을 같은 쪽에 유지합니다. */
      keepWithNextTexts?: string[];
      /** 여러 쪽으로 갈라진 짧은 문단을 다음 쪽에서 통째로 시작합니다. */
      keepLinesTexts?: string[];
      /** 가져온 뒤 텍스트가 일치하는 문단에 한글 문단 속성을 적용합니다. */
      paragraphStyles?: Array<{
        text: string;
        match?: 'exact' | 'prefix';
        props: Record<string, unknown>;
      }>;
      /** marker 문단을 실제 HWP 표로 교체합니다. */
      tables?: Array<{
        marker: string;
        columns: string[];
        rows: Array<Record<string, string>>;
        headerRows?: number;
        labelColumn?: boolean;
        theme?: 'data' | 'summary' | 'overview' | 'cover-title' | 'cover-meta';
        /** 표와 첫 행이 갈라질 경우 함께 다음 쪽으로 옮길 절 제목. */
        headingText?: string;
        /** 표가 다음 쪽으로 밀렸는지 확인할 표 제목. */
        captionText?: string;
        /** 자연 조판을 유지하고 표 묶음을 위한 자동 쪽 나누기를 생략합니다. */
        naturalFlow?: boolean;
      }>;
    };

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

export interface SelectionStyleSnapshot {
  hasSelection: boolean;
  charProps: Record<string, unknown> | null;
  paraProps: Record<string, unknown> | null;
}

export interface SearchTextResult {
  found: boolean;
  wrapped?: boolean;
  sec?: number;
  para?: number;
  charOffset?: number;
  length?: number;
  cellContext?: { parentPara: number; ctrlIdx: number; cellIdx: number; cellPara: number };
}

export type SelectTarget =
  | { kind: 'paragraph'; sectionIndex: number; paragraphIndex: number }
  | { kind: 'textRange'; sectionIndex: number; paragraphIndex: number; charStart: number; charEnd: number }
  | { kind: 'table'; secIdx: number; paraIdx: number; controlIdx: number }
  | { kind: 'tableCell'; secIdx: number; paraIdx: number; controlIdx: number; cellIdx: number };

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
  /** 현재 선택영역 시작점의 글자·문단 속성을 반환합니다. */
  getSelectionStyleSnapshot(): Promise<SelectionStyleSnapshot>;
  /** 문서 전체에서 텍스트를 찾아 구조 위치와 길이를 반환합니다. */
  searchText(query: string, caseSensitive?: boolean): Promise<SearchTextResult>;
  /** 문서의 특정 구조 위치로 이동하거나 해당 문단을 선택합니다. */
  selectTarget(
    target: SelectTarget,
    mode?: 'cursor' | 'text' | 'cell',
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
  /** revision과 선택 앵커가 일치할 때만 선택영역의 글자 서식을 변경합니다. */
  applySelectionCharStyle(
    props: Record<string, unknown>,
    expectedRevision: number,
    expectedSelection: NonNullable<SelectionContext['selection']>,
  ): Promise<{ ok: boolean; context: SelectionContext }>;
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
