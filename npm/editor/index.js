/**
 * @rhwp/editor — HWP 에디터를 iframe으로 임베드
 *
 * 사용법:
 *   import { createEditor } from '@rhwp/editor';
 *   const editor = await createEditor('#container');
 *   await editor.loadFile(buffer, 'document.hwp');
 *
 * 본 제품은 한글과컴퓨터의 한글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
 */

const DEFAULT_STUDIO_URL = 'https://edwardkim.github.io/rhwp/';

let requestId = 0;

/**
 * HWP 에디터를 생성하여 지정된 컨테이너에 마운트합니다.
 *
 * @param container - CSS 셀렉터 또는 HTMLElement
 * @param options - 에디터 옵션
 * @returns RhwpEditor 인스턴스
 *
 * @example
 * ```javascript
 * const editor = await createEditor('#editor');
 * await editor.loadFile(hwpBuffer, 'sample.hwp');
 * console.log(await editor.pageCount());
 * ```
 */
export async function createEditor(container, options = {}) {
  const el = typeof container === 'string'
    ? document.querySelector(container)
    : container;

  if (!el) {
    throw new Error(`Container not found: ${container}`);
  }

  const studioUrl = options.studioUrl || DEFAULT_STUDIO_URL;
  const studioOrigin = new URL(studioUrl).origin;
  if (studioOrigin === 'null') {
    throw new Error('rhwp Studio URL은 HTTP(S) origin이어야 합니다.');
  }

  // iframe 생성
  const iframe = document.createElement('iframe');
  iframe.src = studioUrl;
  iframe.style.width = options.width || '100%';
  iframe.style.height = options.height || '100%';
  iframe.style.border = 'none';
  iframe.allow = 'clipboard-read; clipboard-write';
  el.appendChild(iframe);

  // iframe 로드 대기
  await new Promise((resolve) => {
    iframe.addEventListener('load', resolve, { once: true });
  });

  // WASM 초기화 대기 (ready 메서드로 확인)
  const editor = new RhwpEditor(iframe, studioOrigin);
  await editor._waitReady();
  return editor;
}

/**
 * HWP 에디터 인스턴스
 *
 * iframe 내부의 rhwp-studio와 postMessage로 통신합니다.
 */
export class RhwpEditor {
  constructor(iframe, targetOrigin) {
    this._iframe = iframe;
    this._targetOrigin = targetOrigin;
    this._pending = new Map();

    // 응답 수신 리스너
    this._onMessage = (e) => {
      if (e.source !== this._iframe.contentWindow || e.origin !== this._targetOrigin) return;
      if (e.data?.type === 'rhwp-response' && e.data.id != null) {
        const resolver = this._pending.get(e.data.id);
        if (resolver) {
          this._pending.delete(e.data.id);
          if (e.data.error) {
            resolver.reject(new Error(e.data.error));
          } else {
            resolver.resolve(e.data.result);
          }
        }
      }
    };
    window.addEventListener('message', this._onMessage);
  }

  /**
   * iframe에 요청을 보내고 응답을 기다립니다.
   * @internal
   */
  _request(method, params = {}, timeoutMs = 10000, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      this._pending.set(id, { resolve, reject });
      this._iframe.contentWindow.postMessage(
        { type: 'rhwp-request', id, method, params },
        this._targetOrigin,
        transfer,
      );
      // 문서 변환·렌더링 요청에는 더 긴 제한 시간을 전달할 수 있다.
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  /** WASM 초기화 완료 대기 @internal */
  async _waitReady() {
    for (let i = 0; i < 30; i++) {
      try {
        const result = await this._request('ready');
        if (result) return;
      } catch {
        // 아직 준비 안 됨 — 재시도
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('Editor initialization timeout');
  }

  /**
   * HWP 파일을 로드합니다.
   *
   * @param data - HWP 파일의 ArrayBuffer 또는 Uint8Array
   * @param fileName - 파일 이름 (선택)
   * @returns { pageCount: number }
   *
   * @example
   * ```javascript
   * const resp = await fetch('document.hwp');
   * const buffer = await resp.arrayBuffer();
   * const result = await editor.loadFile(buffer, 'document.hwp');
   * console.log(`${result.pageCount}페이지`);
   * ```
   */
  async loadFile(data, fileName = 'document.hwp', options = {}) {
    // 대용량 HWP를 number[]로 바꾸면 116MB 원본이 수 GB의 JS 객체로 팽창한다.
    // ArrayBuffer를 iframe으로 transfer하면 복사·직렬화 없이 원본 바이트를 전달한다.
    const bytes = data instanceof ArrayBuffer
      ? data
      : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return this._request(
      'loadFile',
      { data: bytes, fileName, validationChoice: options.validationChoice, readOnly: Boolean(options.readOnly) },
      120000,
      [bytes],
    );
  }

  /** 빈 문서를 생성합니다. 생성 뒤 applyAiOperations로 초기 내용을 채울 수 있습니다. */
  async createNewDocument() {
    return this._request('createNewDocument', {}, 30000);
  }

  /**
   * 명시적으로 생성한 문서의 초기 내용 또는 사용자가 확인한 편집 작업을 적용합니다.
   * 선택영역 수정은 replaceSelection을 우선 사용해야 합니다.
   */
  async applyAiOperations(operations) {
    return this._request('applyAiOperations', { operations }, 30000);
  }

  /**
   * 현재 문서의 페이지 수를 반환합니다.
   * @returns 페이지 수
   */
  async pageCount() {
    return this._request('pageCount');
  }

  /**
   * 특정 페이지를 SVG 문자열로 렌더링합니다.
   * @param page - 0부터 시작하는 페이지 번호
   * @returns SVG 문자열
   */
  async getPageSvg(page = 0) {
    return this._request('getPageSvg', { page });
  }

  /** 현재 선택영역의 텍스트·문서 앵커·revision을 반환합니다. */
  async getSelection() {
    return this._request('getSelection');
  }

  /** 현재 선택영역 시작점의 글자·문단 속성을 반환합니다. */
  async getSelectionStyleSnapshot() {
    return this._request('getSelectionStyleSnapshot');
  }

  /** 문서 전체에서 텍스트를 찾아 구조 위치와 길이를 반환합니다. */
  async searchText(query, caseSensitive = false) {
    return this._request('searchText', { query, caseSensitive });
  }

  /**
   * 문서의 특정 구조 위치로 이동하거나 해당 문단을 선택한다.
   * 이 동작은 문서 내용을 변경하지 않으며, 원문 인용 위치 강조에 사용한다.
   */
  async selectTarget(target, mode = 'text') {
    return this._request('selectTarget', { target, mode });
  }

  /** 문서 선택을 바꾸지 않고, 원문 인용 위치의 bounding box를 표시한다. */
  async highlightTarget(target) {
    return this._request('highlightTarget', { target });
  }

  /**
   * 동일한 문서 revision과 선택 앵커가 유지될 때만 선택 텍스트를 교체합니다.
   * AI 수정은 사용자 확인을 받은 뒤 이 메서드로 적용하세요.
   */
  async replaceSelection(text, expectedRevision, expectedSelection) {
    return this._request('replaceSelection', { text, expectedRevision, expectedSelection });
  }

  /** revision과 선택 앵커가 유지될 때만 글자 서식을 적용합니다. */
  async applySelectionCharStyle(props, expectedRevision, expectedSelection) {
    return this._request('applySelectionCharStyleGuarded', { props, expectedRevision, expectedSelection });
  }

  /** 현재 문서를 HWPX 바이트로 내보냅니다. */
  async exportHwpx() {
    return new Uint8Array(await this._request('exportHwpx'));
  }

  async undo() {
    return this._request('undo');
  }

  async redo() {
    return this._request('redo');
  }

  /**
   * iframe 엘리먼트를 반환합니다.
   */
  get element() {
    return this._iframe;
  }

  /**
   * 에디터를 제거합니다.
   */
  destroy() {
    window.removeEventListener('message', this._onMessage);
    this._iframe.remove();
    this._pending.clear();
  }
}
