import type { SelectionRect } from '@/core/types';
import { VirtualScroll } from '@/view/virtual-scroll';

/** 선택 영역을 파란색 반투명 사각형으로 렌더링한다 */
export class SelectionRenderer {
  private layer: HTMLDivElement;
  private highlights: HTMLDivElement[] = [];

  constructor(
    private container: HTMLElement,
    private virtualScroll: VirtualScroll,
  ) {
    this.layer = document.createElement('div');
    this.layer.className = 'selection-layer';
    this.layer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:5;';
    const scrollContent = container.querySelector('#scroll-content');
    if (scrollContent) {
      scrollContent.appendChild(this.layer);
    }
  }

  /** 선택 사각형을 렌더링한다 */
  render(rects: SelectionRect[], zoom: number): void {
    this.clear();
    this.ensureAttached();

    for (const rect of rects) {
      const div = document.createElement('div');
      div.className = 'selection-highlight';
      const pageOffset = this.virtualScroll.getPageOffset(rect.pageIndex);
      const pageLeft = this.calcPageLeft(rect.pageIndex);
      const snapped = this.snapRect(
        pageLeft + rect.x * zoom,
        pageOffset + rect.y * zoom,
        rect.width * zoom,
        rect.height * zoom,
      );

      div.style.cssText =
        `position:absolute;background:rgba(51,144,255,0.35);pointer-events:none;` +
        `left:${snapped.left}px;` +
        `top:${snapped.top}px;` +
        `width:${snapped.width}px;` +
        `height:${snapped.height}px;`;
      this.layer.appendChild(div);
      this.highlights.push(div);
    }
  }

  /** 모든 하이라이트를 제거한다 */
  clear(): void {
    for (const div of this.highlights) {
      div.remove();
    }
    this.highlights = [];
  }

  /** 레이어가 DOM에 없으면 재부착한다 (loadDocument 후 innerHTML 초기화 대응) */
  private ensureAttached(): void {
    if (this.layer.parentElement) return;
    const scrollContent = this.container.querySelector('#scroll-content');
    if (scrollContent) {
      scrollContent.appendChild(this.layer);
    }
  }

  private calcPageLeft(pageIndex: number): number {
    const gridLeft = this.virtualScroll.getPageLeft(pageIndex);
    if (gridLeft >= 0) return gridLeft;

    const scrollContent = this.container.querySelector('#scroll-content');
    const contentWidth = scrollContent?.clientWidth ?? 0;
    const pageDisplayWidth = this.virtualScroll.getPageWidth(pageIndex);
    return (contentWidth - pageDisplayWidth) / 2;
  }

  private snapRect(left: number, top: number, width: number, height: number) {
    const dpr = window.devicePixelRatio || 1;
    const snapDown = (value: number) => Math.floor(value * dpr) / dpr;
    const snapUp = (value: number) => Math.ceil(value * dpr) / dpr;

    const snappedLeft = snapDown(left);
    const snappedRight = snapUp(left + width);
    // 줄별 블럭 사이에 보이는 1px 틈을 줄이기 위해 위/아래를 살짝 확장한다.
    const snappedTop = snapDown(top - 0.5);
    const snappedBottom = snapUp(top + height + 0.5);

    return {
      left: snappedLeft,
      top: snappedTop,
      width: Math.max(1 / dpr, snappedRight - snappedLeft),
      height: Math.max(1 / dpr, snappedBottom - snappedTop),
    };
  }

  dispose(): void {
    this.clear();
    this.layer.remove();
  }
}
