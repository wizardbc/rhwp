import { WasmBridge } from '@/core/wasm-bridge';
import type { DocumentInfo } from '@/core/types';
import { EventBus } from '@/core/event-bus';
import { CanvasView } from '@/view/canvas-view';
import { InputHandler } from '@/engine/input-handler';
import { Toolbar } from '@/ui/toolbar';
import { MenuBar } from '@/ui/menu-bar';
import { getDetectedOSFonts, loadWebFonts, REGISTERED_FONTS } from '@/core/font-loader';
import { CommandRegistry } from '@/command/registry';
import { CommandDispatcher } from '@/command/dispatcher';
import type { EditorContext, CommandServices } from '@/command/types';
import { fileCommands } from '@/command/commands/file';
import { editCommands } from '@/command/commands/edit';
import { viewCommands } from '@/command/commands/view';
import { formatCommands } from '@/command/commands/format';
import { insertCommands } from '@/command/commands/insert';
import { tableCommands } from '@/command/commands/table';
import { pageCommands } from '@/command/commands/page';
import { toolCommands } from '@/command/commands/tool';
import { ContextMenu } from '@/ui/context-menu';
import { CommandPalette } from '@/ui/command-palette';
import { showValidationModalIfNeeded, type ValidationChoice } from '@/ui/validation-modal';
import { showToast } from '@/ui/toast';
import { CellSelectionRenderer } from '@/engine/cell-selection-renderer';
import { TableObjectRenderer } from '@/engine/table-object-renderer';
import { TableResizeRenderer } from '@/engine/table-resize-renderer';
import { Ruler } from '@/view/ruler';

const wasm = new WasmBridge();
const eventBus = new EventBus();

// E2E 테스트용 전역 노출 (개발 모드 전용)
if (import.meta.env.DEV) {
  (window as any).__wasm = wasm;
  (window as any).__eventBus = eventBus;
}
let canvasView: CanvasView | null = null;
let inputHandler: InputHandler | null = null;
let toolbar: Toolbar | null = null;
let ruler: Ruler | null = null;
let appReady = false;
let documentRevision = 0;

// 외부 AI/채팅 bridge가 오래된 선택영역을 덮어쓰지 않도록 모든 문서 변경을
// 단조 증가 revision으로 추적한다. 선택 이동·스크롤은 문서 변경이 아니므로 제외된다.
eventBus.on('document-changed', () => {
  documentRevision += 1;
});

function notifyParentDocumentLoaded(fileName: string, docInfo: DocumentInfo): void {
  if (window.parent === window) return;
  window.parent.postMessage({
    type: 'rhwp-document-loaded',
    fileName,
    pageCount: docInfo.pageCount,
    sectionCount: docInfo.sectionCount ?? 1,
  }, '*');
}


// ─── 커맨드 시스템 ─────────────────────────────
const registry = new CommandRegistry();

function getContext(): EditorContext {
  const hasDoc = wasm.pageCount > 0;
  return {
    hasDocument: hasDoc,
    hasSelection: inputHandler?.hasSelection() ?? false,
    inTable: inputHandler?.isInTable() ?? false,
    inCellSelectionMode: inputHandler?.isInCellSelectionMode() ?? false,
    inTableObjectSelection: inputHandler?.isInTableObjectSelection() ?? false,
    inPictureObjectSelection: inputHandler?.isInPictureObjectSelection() ?? false,
    inField: inputHandler?.isInField() ?? false,
    isEditable: true,
    canUndo: inputHandler?.canUndo() ?? false,
    canRedo: inputHandler?.canRedo() ?? false,
    zoom: canvasView?.getViewportManager().getZoom() ?? 1.0,
    showControlCodes: wasm.getShowControlCodes(),
    sourceFormat: hasDoc ? (wasm.getSourceFormat() as 'hwp' | 'hwpx') : undefined,
  };
}

const commandServices: CommandServices = {
  eventBus,
  wasm,
  getContext,
  getInputHandler: () => inputHandler,
  getViewportManager: () => canvasView?.getViewportManager() ?? null,
};

const dispatcher = new CommandDispatcher(registry, commandServices, eventBus);

// 모든 내장 커맨드 등록
registry.registerAll(fileCommands);
registry.registerAll(editCommands);
registry.registerAll(viewCommands);
registry.registerAll(formatCommands);
registry.registerAll(insertCommands);
registry.registerAll(tableCommands);
registry.registerAll(pageCommands);
registry.registerAll(toolCommands);

function getCommandCatalog(): any {
  const ctx = getContext();
  return registry.getAllIds()
    .map((id) => {
      const command = registry.get(id);
      if (!command) return null;
      return {
        id,
        label: command.label,
        shortcutLabel: command.shortcutLabel,
        icon: command.icon,
        enabled: command.canExecute ? command.canExecute(ctx) : true,
      };
    })
    .filter(Boolean)
    .sort((left: any, right: any) => left.id.localeCompare(right.id));
}

function getPrimitiveToolCatalog(): any[] {
  return [
    {
      id: 'selectTarget',
      label: '대상 선택',
      scope: 'document',
      description: '문단, 표, 표 셀 같은 대상을 먼저 선택하거나 커서를 이동해 이후 편집의 기준점을 만듭니다.',
    },
    {
      id: 'executeCommand',
      label: '에디터 명령 호출',
      scope: 'document',
      description: 'rhwp-studio가 노출한 명령을 직접 실행합니다. 대화상자를 띄우지 않는 즉시 실행 명령에 적합합니다.',
    },
    {
      id: 'moveCursor',
      label: '커서 이동',
      scope: 'cursor',
      description: '문단, 페이지, 검색어 기준으로 커서를 이동합니다.',
    },
    {
      id: 'replaceSelectionOrInsert',
      label: '선택/커서 텍스트 반영',
      scope: 'selection',
      description: '선택된 텍스트를 교체하거나 커서 위치에 새 텍스트를 넣습니다.',
    },
    {
      id: 'insertAtCursor',
      label: '커서 위치 삽입',
      scope: 'cursor',
      description: '현재 커서 위치에 문구나 줄바꿈을 추가합니다.',
    },
    {
      id: 'replaceParagraph',
      label: '문단 교체',
      scope: 'document',
      description: '특정 섹션/문단의 내용을 통째로 교체합니다.',
    },
    {
      id: 'applySelectionCharStyle',
      label: '선택 글자 서식',
      scope: 'selection',
      description: '선택 영역의 글자색, 배경색, 폰트, 크기, 굵기 등을 바꿉니다.',
    },
    {
      id: 'applySelectionParaStyle',
      label: '선택 문단 서식',
      scope: 'selection',
      description: '선택 영역의 정렬, 줄 간격, 들여쓰기, 문단 테두리/배경 등을 바꿉니다.',
    },
    {
      id: 'setCurrentCellProperties',
      label: '표 셀 속성',
      scope: 'table',
      description: '현재 셀 또는 선택된 셀 범위의 배경색, 테두리, 패딩, 정렬을 바꿉니다.',
    },
    {
      id: 'setCurrentTableProperties',
      label: '표 속성',
      scope: 'table',
      description: '현재 표의 배경, 테두리, 배치, 여백, 캡션 관련 속성을 바꿉니다.',
    },
    {
      id: 'fillTargetValue',
      label: '단일 필드/셀 채우기',
      scope: 'document',
      description: '필드, 표 셀, 본문 문단 중 특정 대상을 지정해 값을 채웁니다.',
    },
    {
      id: 'fillManyTargets',
      label: '다중 필드/셀 채우기',
      scope: 'document',
      description: '여러 필드와 셀을 한 번에 채웁니다.',
    },
    {
      id: 'searchText',
      label: '문서 검색',
      scope: 'document',
      description: '문서 전체에서 텍스트를 찾아 관련 위치를 파악합니다.',
    },
    {
      id: 'getPagePng',
      label: '페이지 렌더',
      scope: 'page',
      description: '페이지를 PNG 이미지로 렌더링해 시각적으로 판단할 수 있게 합니다.',
    },
  ];
}

// 상태 바 요소
const sbMessage = () => document.getElementById('sb-message')!;
const sbPage = () => document.getElementById('sb-page')!;
const sbSection = () => document.getElementById('sb-section')!;
const sbZoomVal = () => document.getElementById('sb-zoom-val')!;

async function initialize(): Promise<void> {
  const msg = sbMessage();
  try {
    appReady = false;
    msg.textContent = '웹폰트 로딩 중...';
    await loadWebFonts([]);  // CSS @font-face 등록 + CRITICAL 폰트만 로드
    msg.textContent = 'WASM 로딩 중...';
    await wasm.initialize();
    msg.textContent = 'HWP 파일을 선택해주세요.';

    const container = document.getElementById('scroll-container')!;
    canvasView = new CanvasView(container, wasm, eventBus);

    // 눈금자 초기화
    ruler = new Ruler(
      document.getElementById('h-ruler') as HTMLCanvasElement,
      document.getElementById('v-ruler') as HTMLCanvasElement,
      container,
      eventBus,
      wasm,
      canvasView.getVirtualScroll(),
      canvasView.getViewportManager(),
    );

    inputHandler = new InputHandler(
      container, wasm, eventBus,
      canvasView.getVirtualScroll(),
      canvasView.getViewportManager(),
    );

    toolbar = new Toolbar(document.getElementById('style-bar')!, wasm, eventBus, dispatcher);
    toolbar.setEnabled(false);

    // InputHandler에 커맨드 디스패처 및 컨텍스트 메뉴 주입
    inputHandler.setDispatcher(dispatcher);
    inputHandler.setContextMenu(new ContextMenu(dispatcher, registry));
    inputHandler.setCommandPalette(new CommandPalette(registry, dispatcher));
    inputHandler.setCellSelectionRenderer(
      new CellSelectionRenderer(container, canvasView.getVirtualScroll()),
    );
    inputHandler.setTableObjectRenderer(
      new TableObjectRenderer(container, canvasView.getVirtualScroll()),
    );
    inputHandler.setTableResizeRenderer(
      new TableResizeRenderer(container, canvasView.getVirtualScroll()),
    );
    inputHandler.setPictureObjectRenderer(
      new TableObjectRenderer(container, canvasView.getVirtualScroll(), true),
    );

    new MenuBar(document.getElementById('menu-bar')!, eventBus, dispatcher);

    // 툴바 내 data-cmd 버튼 클릭 → 커맨드 디스패치
    document.querySelectorAll('.tb-btn[data-cmd]').forEach(btn => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const cmd = (btn as HTMLElement).dataset.cmd;
        if (cmd) dispatcher.dispatch(cmd, { anchorEl: btn as HTMLElement });
      });
    });

    // 스플릿 버튼 드롭다운 메뉴
    document.querySelectorAll('.tb-split').forEach(split => {
      const arrow = split.querySelector('.tb-split-arrow');
      if (arrow) {
        arrow.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          // 다른 열린 메뉴 닫기
          document.querySelectorAll('.tb-split.open').forEach(s => {
            if (s !== split) s.classList.remove('open');
          });
          split.classList.toggle('open');
        });
      }
      split.querySelectorAll('.tb-split-item[data-cmd]').forEach(item => {
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          split.classList.remove('open');
          const cmd = (item as HTMLElement).dataset.cmd;
          if (cmd) dispatcher.dispatch(cmd, { anchorEl: item as HTMLElement });
        });
      });
    });
    // 외부 클릭 시 스플릿 메뉴 닫기
    document.addEventListener('mousedown', () => {
      document.querySelectorAll('.tb-split.open').forEach(s => s.classList.remove('open'));
    });

    setupFileInput();
    setupZoomControls();
    setupEventListeners();
    setupGlobalShortcuts();
    loadFromUrlParam();

    // E2E 테스트용 전역 노출 (개발 모드 전용)
    if (import.meta.env.DEV) {
      (window as any).__inputHandler = inputHandler;
      (window as any).__canvasView = canvasView;
    }
    appReady = true;
  } catch (error) {
    appReady = false;
    msg.textContent = `WASM 초기화 실패: ${error}`;
    console.error('[main] WASM 초기화 실패:', error);
  }
}

/**
 * 전역 단축키 핸들러 — InputHandler.active 여부와 무관하게 동작해야 하는 단축키.
 * 예: 문서 미로드 상태에서도 Alt+N(새 문서), Ctrl+O(열기) 등.
 */
function setupGlobalShortcuts(): void {
  document.addEventListener('keydown', (e) => {
    // input/textarea 등 편집 가능 요소 내부에서는 무시
    const target = e.target as HTMLElement;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    // InputHandler가 활성 상태이면 자체 처리에 맡김
    if (inputHandler?.isActive()) return;

    const ctrlOrMeta = e.ctrlKey || e.metaKey;

    // Alt+N / Alt+ㅜ → 새 문서 (문서 미로드 상태에서도 동작)
    if (e.altKey && !ctrlOrMeta && !e.shiftKey) {
      if (e.key === 'n' || e.key === 'N' || e.key === 'ㅜ') {
        e.preventDefault();
        dispatcher.dispatch('file:new-doc');
        return;
      }
    }
  }, false);
}

function setupFileInput(): void {
  const fileInput = document.getElementById('file-input') as HTMLInputElement;

  const handleSelectedFile = async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const name = file.name.toLowerCase();
    if (!name.endsWith('.hwp') && !name.endsWith('.hwpx')) {
      alert('HWP/HWPX 파일만 지원합니다.');
      fileInput.value = '';
      return;
    }
    await loadFile(file);
    fileInput.value = '';
  };

  fileInput.addEventListener('change', () => {
    void handleSelectedFile();
  });
  fileInput.addEventListener('input', () => {
    void handleSelectedFile();
  });
  fileInput.onchange = () => {
    void handleSelectedFile();
  };

  // 문서 전체에서 브라우저 기본 드롭 동작 방지 (파일 열기/다운로드 방지)
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  // 드래그 앤 드롭 지원 (scroll-container 영역)
  const container = document.getElementById('scroll-container')!;
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    container.classList.add('drag-over');
  });
  container.addEventListener('dragleave', () => {
    container.classList.remove('drag-over');
  });
  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    container.classList.remove('drag-over');
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    const dropName = file.name.toLowerCase();
    if (!dropName.endsWith('.hwp') && !dropName.endsWith('.hwpx')) {
      alert('HWP/HWPX 파일만 지원합니다.');
      return;
    }
    await loadFile(file);
  });
}

function setupZoomControls(): void {
  if (!canvasView) return;
  const vm = canvasView.getViewportManager();

  document.getElementById('sb-zoom-in')!.addEventListener('click', () => {
    vm.setZoom(vm.getZoom() + 0.1);
  });
  document.getElementById('sb-zoom-out')!.addEventListener('click', () => {
    vm.setZoom(vm.getZoom() - 0.1);
  });

  // 폭 맞춤: 용지 폭에 맞게 줌 조절
  document.getElementById('sb-zoom-fit-width')!.addEventListener('click', () => {
    if (wasm.pageCount === 0) return;
    const container = document.getElementById('scroll-container')!;
    const containerWidth = container.clientWidth - 40; // 좌우 여백 제외
    const pageInfo = wasm.getPageInfo(0);
    // pageInfo.width는 이미 px 단위 (96dpi 기준)
    const zoom = containerWidth / pageInfo.width;
    console.log(`[zoom-fit-width] container=${containerWidth} page=${pageInfo.width} zoom=${zoom.toFixed(3)}`);
    vm.setZoom(Math.max(0.1, Math.min(zoom, 4.0)));
  });

  // 쪽 맞춤: 한 페이지 전체가 보이도록 줌 조절
  document.getElementById('sb-zoom-fit')!.addEventListener('click', () => {
    if (wasm.pageCount === 0) return;
    const container = document.getElementById('scroll-container')!;
    const containerWidth = container.clientWidth - 40;
    const containerHeight = container.clientHeight - 40;
    const pageInfo = wasm.getPageInfo(0);
    // pageInfo.width/height는 이미 px 단위 (96dpi 기준)
    const zoomW = containerWidth / pageInfo.width;
    const zoomH = containerHeight / pageInfo.height;
    console.log(`[zoom-fit-page] containerW=${containerWidth} containerH=${containerHeight} pageW=${pageInfo.width} pageH=${pageInfo.height} zoomW=${zoomW.toFixed(3)} zoomH=${zoomH.toFixed(3)}`);
    vm.setZoom(Math.max(0.1, Math.min(zoomW, zoomH, 4.0)));
  });

  // 모바일: 줌 값 클릭 → 100% 토글
  document.getElementById('sb-zoom-val')!.addEventListener('click', () => {
    const currentZoom = vm.getZoom();
    if (Math.abs(currentZoom - 1.0) < 0.05) {
      // 현재 100% → 쪽 맞춤으로 전환
      document.getElementById('sb-zoom-fit')!.click();
    } else {
      // 현재 쪽 맞춤/기타 → 100%로 전환
      vm.setZoom(1.0);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      vm.setZoom(vm.getZoom() + 0.1);
    } else if (e.key === '-') {
      e.preventDefault();
      vm.setZoom(vm.getZoom() - 0.1);
    } else if (e.key === '0') {
      e.preventDefault();
      vm.setZoom(1.0);
    }
  });
}

let totalSections = 1;

function setupEventListeners(): void {
  eventBus.on('current-page-changed', (page, _total) => {
    const pageIdx = page as number;
    sbPage().textContent = `${pageIdx + 1} / ${_total} 쪽`;

    // 구역 정보: 현재 페이지의 sectionIndex로 갱신
    if (wasm.pageCount > 0) {
      try {
        const pageInfo = wasm.getPageInfo(pageIdx);
        sbSection().textContent = `구역: ${pageInfo.sectionIndex + 1} / ${totalSections}`;
      } catch { /* 무시 */ }
    }
  });

  eventBus.on('zoom-level-display', (zoom) => {
    sbZoomVal().textContent = `${Math.round((zoom as number) * 100)}%`;
  });

  // 삽입/수정 모드 토글
  eventBus.on('insert-mode-changed', (insertMode) => {
    document.getElementById('sb-mode')!.textContent = (insertMode as boolean) ? '삽입' : '수정';
  });

  // 필드 정보 표시
  const sbField = document.getElementById('sb-field');
  eventBus.on('field-info-changed', (info) => {
    if (!sbField) return;
    const fi = info as { fieldId: number; fieldType: string; guideName?: string } | null;
    if (fi) {
      const label = fi.guideName || `#${fi.fieldId}`;
      sbField.textContent = `[누름틀] ${label}`;
      sbField.style.display = '';
    } else {
      sbField.textContent = '';
      sbField.style.display = 'none';
    }
  });

  // 개체 선택 시 회전/대칭 버튼 그룹 표시/숨김
  const rotateGroup = document.querySelector('.tb-rotate-group') as HTMLElement | null;
  if (rotateGroup) {
    eventBus.on('picture-object-selection-changed', (selected) => {
      rotateGroup.style.display = (selected as boolean) ? '' : 'none';
    });
  }

  // 머리말/꼬리말 편집 모드 시 도구상자 전환 + 본문 dimming
  const hfGroup = document.querySelector('.tb-headerfooter-group') as HTMLElement | null;
  const hfLabel = hfGroup?.querySelector('.tb-hf-label') as HTMLElement | null;
  const defaultTbGroups = document.querySelectorAll('#icon-toolbar > .tb-group:not(.tb-headerfooter-group):not(.tb-rotate-group), #icon-toolbar > .tb-sep');
  const scrollContainer = document.getElementById('scroll-container');
  const styleBar = document.getElementById('style-bar');

  eventBus.on('headerFooterModeChanged', (mode) => {
    const isActive = (mode as string) !== 'none';
    // 도구상자 전환
    if (hfGroup) {
      hfGroup.style.display = isActive ? '' : 'none';
    }
    if (hfLabel) {
      hfLabel.textContent = (mode as string) === 'header' ? '머리말' : (mode as string) === 'footer' ? '꼬리말' : '';
    }
    defaultTbGroups.forEach((el) => {
      (el as HTMLElement).style.display = isActive ? 'none' : '';
    });
    // 서식 도구 모음은 머리말/꼬리말 편집 시에도 유지 (문단/글자 모양 설정 필요)
    // 본문 dimming
    if (scrollContainer) {
      if (isActive) {
        scrollContainer.classList.add('hf-editing');
      } else {
        scrollContainer.classList.remove('hf-editing');
      }
    }
  });
}

/** 문서 초기화 공통 시퀀스 (loadFile, createNewDocument 양쪽에서 사용) */
type DocumentInitializationOptions = {
  /** Citation viewers must never modify the original merely to render it. */
  validationChoice?: 'prompt' | 'as-is';
  /** Source viewers permit selection and copy, but never document edits. */
  readOnly?: boolean;
};

async function initializeDocument(
  docInfo: DocumentInfo,
  displayName: string,
  options: DocumentInitializationOptions = {},
): Promise<void> {
  const msg = sbMessage();
  try {
    documentRevision += 1;
    console.log('[initDoc] 1. 폰트 로딩 시작');
    if (docInfo.fontsUsed?.length) {
      await loadWebFonts(docInfo.fontsUsed, (loaded, total) => {
        msg.textContent = `폰트 로딩 중... (${loaded}/${total})`;
      });
    }
    console.log('[initDoc] 2. 폰트 로딩 완료');
    msg.textContent = displayName;
    totalSections = docInfo.sectionCount ?? 1;
    sbSection().textContent = `구역: 1 / ${totalSections}`;
    console.log('[initDoc] 3. inputHandler deactivate');
    inputHandler?.deactivate();
    console.log('[initDoc] 4. canvasView loadDocument');
    canvasView?.loadDocument();
    const readOnly = Boolean(options.readOnly);
    document.documentElement.classList.toggle('rhwp-read-only', readOnly);
    inputHandler?.setReadOnly(readOnly);
    console.log('[initDoc] 5. toolbar setEnabled');
    toolbar?.setEnabled(!readOnly);
    console.log('[initDoc] 6. toolbar initStyleDropdown');
    if (!readOnly) toolbar?.initStyleDropdown();
    console.log('[initDoc] 7. inputHandler activateWithCaretPosition');
    inputHandler?.activateWithCaretPosition();
    console.log('[initDoc] 8. 완료');

    // #177: HWPX 비표준 lineseg 감지 → 경고 있으면 모달로 사용자 선택 요청
    try {
      const report = wasm.getValidationWarnings();
      console.log(`[validation] ${report.count} warnings`, report.summary);
      if (report.count > 0) {
        const choice: ValidationChoice = options.validationChoice === 'as-is'
          ? 'as-is'
          : await showValidationModalIfNeeded(report);
        console.log(`[validation] user choice: ${choice}`);
        if (choice === 'auto-fix') {
          const n = wasm.reflowLinesegs();
          console.log(`[validation] reflowed ${n} paragraphs`);
          // 렌더 재계산
          canvasView?.loadDocument();
          msg.textContent = `${displayName} (비표준 lineseg ${n}건 자동 보정됨)`;
        }
      }
    } catch (e) {
      console.warn('[validation] 감지/보정 실패 (치명적이지 않음):', e);
    }
    notifyParentDocumentLoaded(wasm.fileName, docInfo);
  } catch (error) {
    console.error('[initDoc] 오류:', error);
    if (window.innerWidth < 768) alert(`초기화 오류: ${error}`);
  }
}

async function loadFile(file: File): Promise<void> {
  const msg = sbMessage();
  try {
    msg.textContent = '파일 로딩 중...';
    const startTime = performance.now();
    const data = new Uint8Array(await file.arrayBuffer());
    await loadBytes(data, file.name, null, startTime);
  } catch (error) {
    const errMsg = `파일 로드 실패: ${error}`;
    msg.textContent = errMsg;
    console.error('[main] 파일 로드 실패:', error);
    // 모바일에서 상태 메시지가 숨겨질 수 있으므로 alert으로도 표시
    if (window.innerWidth < 768) alert(errMsg);
  }
}

async function loadBytes(
  data: Uint8Array,
  fileName: string,
  fileHandle: typeof wasm.currentFileHandle,
  startTime = performance.now(),
): Promise<void> {
  const docInfo = wasm.loadDocument(data, fileName);
  wasm.currentFileHandle = fileHandle;
  const elapsed = performance.now() - startTime;
  // initializeDocument 안에서 #177 validation 모달이 표시될 수 있음.
  // HWPX 토스트는 모달과의 이벤트 충돌을 피하기 위해 모달 닫힌 후 표시.
  await initializeDocument(docInfo, `${fileName} — ${docInfo.pageCount}페이지 (${elapsed.toFixed(1)}ms)`);
  notifyHwpxBetaIfNeeded();
}

/**
 * #196: HWPX 출처 문서 로드 시 베타 안내 (저장 비활성화).
 * - 우상단 토스트 1회
 * - 상태 표시줄 메시지
 *
 * #197 (HWPX→HWP 완전 변환기) 완료 시 본 함수 제거.
 */
function notifyHwpxBetaIfNeeded(): void {
  if (wasm.getSourceFormat() !== 'hwpx') return;

  showToast({
    message: 'HWPX 형식은 현재 베타 단계라 직접 저장이 비활성화되어 있습니다.\n다음 업데이트에서 지원 예정입니다.',
    durationMs: 0, // 자동 페이드 없음 — 사용자가 확인 버튼으로 닫음
    action: {
      label: '자세히',
      onClick: () => {
        window.open('https://github.com/edwardkim/rhwp/issues/197', '_blank');
      },
    },
    confirmLabel: '확인',
  });

  const sb = sbMessage();
  if (sb) sb.textContent = 'HWPX 베타 모드 — 저장은 다음 업데이트에서 지원됩니다';
}

async function createNewDocument(): Promise<{ pageCount: number }> {
  const msg = sbMessage();
  try {
    msg.textContent = '새 문서 생성 중...';
    const docInfo = wasm.createNewDocument();
    await initializeDocument(docInfo, `새 문서.hwp — ${docInfo.pageCount}페이지`);
    return { pageCount: docInfo.pageCount };
  } catch (error) {
    msg.textContent = `새 문서 생성 실패: ${error}`;
    console.error('[main] 새 문서 생성 실패:', error);
    throw error;
  }
}

// 커맨드에서 새 문서 생성 호출
eventBus.on('create-new-document', () => { createNewDocument(); });
eventBus.on('open-document-bytes', async (payload) => {
  const data = payload as {
    bytes: Uint8Array;
    fileName: string;
    fileHandle: typeof wasm.currentFileHandle;
  };
  await loadBytes(data.bytes, data.fileName, data.fileHandle);
});

// 수식 더블클릭 → 수식 편집 대화상자
eventBus.on('equation-edit-request', () => {
  dispatcher.dispatch('insert:equation-edit');
});

/**
 * URL 파라미터(?url=)로 전달된 HWP 파일을 자동 로드한다.
 * Chrome 확장 프로그램에서 뷰어 탭을 열 때 사용.
 */
async function loadFromUrlParam(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const fileUrl = params.get('url');
  if (!fileUrl) return;

  const fileName = params.get('filename') || fileUrl.split('/').pop()?.split('?')[0] || 'document.hwp';
  const msg = sbMessage();

  try {
    msg.textContent = '파일 로딩 중...';
    console.log(`[loadFromUrlParam] ${fileUrl}`);

    let response: Response;

    // Chrome 확장 환경: Service Worker를 통한 CORS 우회 fetch
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try {
        response = await fetch(fileUrl);
      } catch {
        // 직접 fetch 실패 시 Service Worker 프록시
        const result = await chrome.runtime.sendMessage({ type: 'fetch-file', url: fileUrl });
        if (result.error) throw new Error(result.error);
        const data = new Uint8Array(result.data);
        const docInfo = wasm.loadDocument(data, fileName);
        await initializeDocument(docInfo, `${fileName} — ${docInfo.pageCount}페이지`);
        return;
      }
    } else {
      response = await fetch(fileUrl);
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const buffer = await response.arrayBuffer();
    const data = new Uint8Array(buffer);
    const docInfo = wasm.loadDocument(data, fileName);
    await initializeDocument(docInfo, `${fileName} — ${docInfo.pageCount}페이지`);
  } catch (error) {
    const errMsg = `파일 로드 실패: ${error}`;
    msg.textContent = errMsg;
    console.error('[loadFromUrlParam]', error);
  }
}

function stripHtmlTags(html: string): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return (tmp.textContent || '').replace(/\u00a0/g, ' ').trim();
}

async function svgToPngDataUrl(svg: string): Promise<string> {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('SVG 렌더링 실패'));
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.width || 1;
    canvas.height = img.height || 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D 컨텍스트를 만들 수 없습니다');
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function getCursorPageIndex(pos: any): number {
  try {
    if (!pos) return 0;
    if (pos.parentParaIndex !== undefined) {
      if (pos.cellPath?.length) {
        const rect = wasm.getCursorRectByPath(pos.sectionIndex, pos.parentParaIndex, JSON.stringify(pos.cellPath), pos.charOffset);
        return rect?.pageIndex ?? 0;
      }
      if (pos.isTextBox) {
        const rect = wasm.getCursorRectInCell(pos.sectionIndex, pos.parentParaIndex, pos.controlIndex, pos.cellIndex, pos.cellParaIndex, pos.charOffset);
        return rect?.pageIndex ?? 0;
      }
      const rect = wasm.getCursorRectInCell(pos.sectionIndex, pos.parentParaIndex, pos.controlIndex, pos.cellIndex, pos.cellParaIndex, pos.charOffset);
      return rect?.pageIndex ?? 0;
    }
    const rect = wasm.getCursorRect(pos.sectionIndex, pos.paragraphIndex, pos.charOffset);
    return rect?.pageIndex ?? 0;
  } catch {
    return 0;
  }
}

function getSelectionContext(): any {
  const selection = inputHandler?.getSelection();
  const cursor = inputHandler?.getCursorPosition?.() ?? inputHandler?.getPosition?.() ?? null;
  const pageIndex = selection ? getCursorPageIndex(selection.start) : getCursorPageIndex(cursor);
  const selectedTableRef = inputHandler?.getSelectedTableRef?.() ?? null;
  const selectedPictureRef = inputHandler?.getSelectedPictureRef?.() ?? null;
  const selectedCellRange = inputHandler?.getSelectedCellRange?.() ?? null;
  let selectedHtml = '';
  let selectedText = '';

  if (selection) {
    const { start, end } = selection;
    try {
      if (start.parentParaIndex !== undefined && end.parentParaIndex !== undefined) {
        if (start.cellPath?.length || end.cellPath?.length) {
          if (JSON.stringify(start.cellPath ?? []) === JSON.stringify(end.cellPath ?? [])
            && start.parentParaIndex === end.parentParaIndex
            && start.cellParaIndex === end.cellParaIndex) {
            const pathJson = JSON.stringify(start.cellPath ?? []);
            const count = Math.max(0, end.charOffset - start.charOffset);
            selectedText = wasm.getTextInCellByPath(start.sectionIndex, start.parentParaIndex, pathJson, start.charOffset, count);
            selectedHtml = `<p>${selectedText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
          }
        } else if (
          start.parentParaIndex === end.parentParaIndex
          && start.controlIndex === end.controlIndex
          && start.cellIndex === end.cellIndex
        ) {
          const controlIndex = start.controlIndex;
          const cellIndex = start.cellIndex;
          if (controlIndex === undefined || cellIndex === undefined) {
            throw new Error('셀 선택 정보가 불완전합니다');
          }
          selectedHtml = wasm.exportSelectionInCellHtml(
            start.sectionIndex,
            start.parentParaIndex,
            controlIndex,
            cellIndex,
            start.cellParaIndex ?? 0,
            start.charOffset,
            end.cellParaIndex ?? 0,
            end.charOffset,
          );
        }
      } else {
        selectedHtml = wasm.exportSelectionHtml(
          start.sectionIndex,
          start.paragraphIndex,
          start.charOffset,
          end.paragraphIndex,
          end.charOffset,
        );
      }
    } catch (error) {
      console.warn('[rhwp-postmessage] 선택 영역 export 실패:', error);
    }
    if (!selectedText && selectedHtml) {
      selectedText = stripHtmlTags(selectedHtml);
    }
  }

  // Capability detection runs before a file is opened as well.  The wasm
  // binding may reject document-info access then, but selection-v1 is still
  // available and needs to be reported to the embedding application.
  let documentInfo = null;
  try {
    documentInfo = wasm.getDocumentInfo();
  } catch (_error) {
    // No document is currently loaded.
  }

  return {
    documentRevision,
    hasSelection: !!selection,
    selection,
    cursor,
    pageIndex,
    tableObjectSelection: selectedTableRef ? {
      secIdx: selectedTableRef.sec,
      paraIdx: selectedTableRef.ppi,
      controlIdx: selectedTableRef.ci,
    } : null,
    pictureObjectSelection: selectedPictureRef ? {
      secIdx: selectedPictureRef.sec,
      paraIdx: selectedPictureRef.ppi,
      controlIdx: selectedPictureRef.ci,
      objectType: selectedPictureRef.type,
    } : null,
    cellSelection: selectedCellRange ?? null,
    selectedHtml,
    selectedText,
    documentInfo,
  };
}

function getEditorModeSnapshot(): any {
  const context = getContext();
  const selection = getSelectionContext();
  const cursor = (inputHandler?.getCursorPosition?.() ?? inputHandler?.getPosition?.() ?? null) as Record<string, unknown> | null;
  const selectedTableRef = inputHandler?.getSelectedTableRef?.() ?? null;
  const selectedPictureRef = inputHandler?.getSelectedPictureRef?.() ?? null;
  const selectedCellRange = inputHandler?.getSelectedCellRange?.() ?? null;

  let currentTable: any = null;
  let currentCell: any = null;
  let currentPicture: any = null;

  if (cursor?.parentParaIndex !== undefined && cursor?.controlIndex !== undefined) {
    try {
      currentTable = {
        ref: {
          secIdx: Number(cursor.sectionIndex),
          paraIdx: Number(cursor.parentParaIndex),
          controlIdx: Number(cursor.controlIndex),
        },
        properties: wasm.getTableProperties(Number(cursor.sectionIndex), Number(cursor.parentParaIndex), Number(cursor.controlIndex)),
        dimensions: wasm.getTableDimensions(Number(cursor.sectionIndex), Number(cursor.parentParaIndex), Number(cursor.controlIndex)),
      };
      if (cursor?.cellIndex !== undefined) {
        currentCell = {
          cellIdx: Number(cursor.cellIndex),
          info: wasm.getCellInfo(Number(cursor.sectionIndex), Number(cursor.parentParaIndex), Number(cursor.controlIndex), Number(cursor.cellIndex)),
          properties: wasm.getCellProperties(Number(cursor.sectionIndex), Number(cursor.parentParaIndex), Number(cursor.controlIndex), Number(cursor.cellIndex)),
        };
      }
    } catch (error) {
      console.warn('[rhwp-postmessage] 현재 표 컨텍스트 조회 실패:', error);
    }
  }

  if (selectedPictureRef) {
    try {
      currentPicture = {
        ref: {
          secIdx: selectedPictureRef.sec,
          paraIdx: selectedPictureRef.ppi,
          controlIdx: selectedPictureRef.ci,
          objectType: selectedPictureRef.type,
        },
        properties: selectedPictureRef.type === 'image'
          ? wasm.getPictureProperties(selectedPictureRef.sec, selectedPictureRef.ppi, selectedPictureRef.ci)
          : selectedPictureRef.type === 'shape' || selectedPictureRef.type === 'line'
            ? wasm.getShapeProperties(selectedPictureRef.sec, selectedPictureRef.ppi, selectedPictureRef.ci)
            : null,
      };
    } catch (error) {
      console.warn('[rhwp-postmessage] 현재 개체 컨텍스트 조회 실패:', error);
    }
  }

  return {
    context,
    selection,
    cursor,
    selectedTableRef: selectedTableRef ? {
      secIdx: selectedTableRef.sec,
      paraIdx: selectedTableRef.ppi,
      controlIdx: selectedTableRef.ci,
      cellPath: selectedTableRef.cellPath ?? null,
    } : null,
    selectedPictureRef: selectedPictureRef ? {
      secIdx: selectedPictureRef.sec,
      paraIdx: selectedPictureRef.ppi,
      controlIdx: selectedPictureRef.ci,
      objectType: selectedPictureRef.type,
      cellIdx: selectedPictureRef.cellIdx,
      cellParaIdx: selectedPictureRef.cellParaIdx,
    } : null,
    selectedCellRange: selectedCellRange ?? null,
    currentTable,
    currentCell,
    currentPicture,
  };
}

function getSelectionStyleSnapshot(): any {
  const selection = inputHandler?.getSelection();
  const cursor = (inputHandler?.getCursorPosition?.() ?? inputHandler?.getPosition?.() ?? null) as Record<string, unknown> | null;
  const anchor = (selection?.start as Record<string, unknown> | undefined) ?? cursor;
  if (!anchor) {
    return {
      hasSelection: false,
      charProps: null,
      paraProps: null,
    };
  }

  try {
    if (anchor.parentParaIndex !== undefined) {
      return {
        hasSelection: !!selection,
        charProps: wasm.getCellCharPropertiesAt(
          Number(anchor.sectionIndex),
          Number(anchor.parentParaIndex),
          Number(anchor.controlIndex),
          Number(anchor.cellIndex),
          Number(anchor.cellParaIndex ?? 0),
          Number(anchor.charOffset ?? 0),
        ),
        paraProps: wasm.getCellParaPropertiesAt(
          Number(anchor.sectionIndex),
          Number(anchor.parentParaIndex),
          Number(anchor.controlIndex),
          Number(anchor.cellIndex),
          Number(anchor.cellParaIndex ?? 0),
        ),
      };
    }

    return {
      hasSelection: !!selection,
      charProps: wasm.getCharPropertiesAt(Number(anchor.sectionIndex), Number(anchor.paragraphIndex), Number(anchor.charOffset ?? 0)),
      paraProps: wasm.getParaPropertiesAt(Number(anchor.sectionIndex), Number(anchor.paragraphIndex)),
    };
  } catch (error) {
    console.warn('[rhwp-postmessage] 선택 영역 스타일 조회 실패:', error);
    return {
      hasSelection: !!selection,
      charProps: null,
      paraProps: null,
    };
  }
}

function replaceBodyParagraphText(secIdx: number, paraIdx: number, text: string): void {
  const paraLen = wasm.getParagraphLength(secIdx, paraIdx);
  if (paraLen > 0) {
    wasm.deleteRange(secIdx, paraIdx, 0, paraIdx, paraLen);
  }
  wasm.insertText(secIdx, paraIdx, 0, text);
}

function applyFieldValueWithFallback(target: any, text: string) {
  try {
    wasm.setFieldValueByName(target.name, text);
    return;
  } catch (error) {
    console.warn('[fillFormValues] field API fallback', target.name, error);
  }

  const location = target.location;
  if (!location || typeof location.sectionIndex !== 'number' || typeof location.paraIndex !== 'number') {
    throw new Error(`필드 위치 정보를 찾지 못했습니다: ${target.name ?? 'unknown field'}`);
  }

  const firstPath = Array.isArray(location.path) ? location.path[0] : undefined;
  if (
    firstPath?.type === 'cell' &&
    typeof firstPath.controlIndex === 'number' &&
    typeof firstPath.cellIndex === 'number'
  ) {
    replaceTopLevelCellText({
      secIdx: location.sectionIndex,
      paraIdx: location.paraIndex,
      controlIdx: firstPath.controlIndex,
      cellIdx: firstPath.cellIndex,
    }, text);
    return;
  }

  replaceBodyParagraphText(location.sectionIndex, location.paraIndex, text);
}

function fillFormValuesDirect(entries: Array<{ target: any; value: string }>): void {
  for (const entry of entries) {
    if (!entry?.target) continue;
    const value = entry.value ?? '';
    if (entry.target.kind === 'fieldByName') {
      applyFieldValueWithFallback(entry.target, value);
      continue;
    }
    if (entry.target.kind === 'tableCell') {
      replaceTopLevelCellText(entry.target, value);
      continue;
    }
    if (entry.target.kind === 'bodyParagraph') {
      replaceBodyParagraphText(entry.target.secIdx, entry.target.paraIdx, value);
    }
  }
}

function applyTextEditDirect(text: string): any {
  if (!inputHandler) throw new Error('에디터가 아직 준비되지 않았습니다');
  const selection = inputHandler.getSelection();
  const normalized = text.replace(/\r\n/g, '\n');

  if (selection) {
    const { start, end } = selection;
    if (start.parentParaIndex !== undefined && end.parentParaIndex !== undefined) {
      if (start.cellPath?.length || end.cellPath?.length) {
        const samePath = JSON.stringify(start.cellPath ?? []) === JSON.stringify(end.cellPath ?? []);
        if (!samePath || start.parentParaIndex !== end.parentParaIndex || start.cellParaIndex !== end.cellParaIndex) {
          throw new Error('중첩 표 선택 편집은 현재 단일 문단 범위만 지원합니다');
        }
        const pathJson = JSON.stringify(start.cellPath ?? []);
        const deleteCount = Math.max(0, end.charOffset - start.charOffset);
        if (deleteCount > 0) {
          wasm.deleteTextInCellByPath(start.sectionIndex, start.parentParaIndex, pathJson, start.charOffset, deleteCount);
        }
        wasm.insertTextInCellByPath(start.sectionIndex, start.parentParaIndex, pathJson, start.charOffset, normalized);
        return {
          ...start,
          charOffset: start.charOffset + normalized.length,
        };
      } else {
        wasm.deleteRangeInCell(
          start.sectionIndex,
          start.parentParaIndex,
          start.controlIndex!,
          start.cellIndex!,
          start.cellParaIndex ?? 0,
          start.charOffset,
          end.cellParaIndex ?? 0,
          end.charOffset,
        );
        wasm.insertTextInCell(
          start.sectionIndex,
          start.parentParaIndex,
          start.controlIndex!,
          start.cellIndex!,
          start.cellParaIndex ?? 0,
          start.charOffset,
          normalized,
        );
        return {
          ...start,
          charOffset: start.charOffset + normalized.length,
        };
      }
    } else {
      wasm.deleteRange(
        start.sectionIndex,
        start.paragraphIndex,
        start.charOffset,
        end.paragraphIndex,
        end.charOffset,
      );
      wasm.insertText(start.sectionIndex, start.paragraphIndex, start.charOffset, normalized);
      return {
        ...start,
        charOffset: start.charOffset + normalized.length,
      };
    }
  } else {
    const pos = inputHandler.getCursorPosition();
    if (!pos) throw new Error('커서 위치를 찾을 수 없습니다');
    if (pos.parentParaIndex !== undefined) {
      if (pos.cellPath?.length) {
        wasm.insertTextInCellByPath(pos.sectionIndex, pos.parentParaIndex, JSON.stringify(pos.cellPath), pos.charOffset, normalized);
      } else {
        wasm.insertTextInCell(
          pos.sectionIndex,
          pos.parentParaIndex,
          pos.controlIndex!,
          pos.cellIndex!,
          pos.cellParaIndex ?? 0,
          pos.charOffset,
          normalized,
        );
      }
    } else {
      wasm.insertText(pos.sectionIndex, pos.paragraphIndex, pos.charOffset, normalized);
    }
    return {
      ...pos,
      charOffset: pos.charOffset + normalized.length,
    };
  }
}

function applyTextEdit(text: string): any {
  if (!inputHandler) throw new Error('에디터가 아직 준비되지 않았습니다');
  inputHandler.executeOperation({
    kind: 'snapshot',
    operationType: 'ai-text-edit',
    operation: () => {
      return applyTextEditDirect(text);
    },
  });
  return getSelectionContext();
}

function sameSelectionAnchor(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Chat host가 승인한 텍스트 변경만 적용한다. 사용자가 그 사이 문서를 수정하거나
 * 다른 영역을 선택했다면 변경하지 않고 STALE_SELECTION 오류를 반환한다.
 */
function replaceSelectionWithGuard(params: {
  text?: unknown;
  expectedRevision?: unknown;
  expectedSelection?: unknown;
}): any {
  if (!inputHandler) throw new Error('에디터가 아직 준비되지 않았습니다');
  if (typeof params.text !== 'string') throw new Error('교체할 텍스트가 필요합니다.');
  if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision !== documentRevision) {
    throw new Error('STALE_SELECTION: 문서가 변경되었습니다. 선택 영역을 다시 읽어주세요.');
  }

  const actualSelection = inputHandler.getSelection();
  if (!actualSelection) {
    throw new Error('STALE_SELECTION: 현재 선택 영역이 없습니다.');
  }
  const expected = params.expectedSelection as { start?: unknown; end?: unknown } | undefined;
  if (!expected?.start || !expected?.end
    || !sameSelectionAnchor(expected.start, actualSelection.start)
    || !sameSelectionAnchor(expected.end, actualSelection.end)) {
    throw new Error('STALE_SELECTION: 선택 영역이 변경되었습니다.');
  }

  const revisionBeforeEdit = documentRevision;
  const context = applyTextEdit(params.text);
  // 일부 구형 edit 경로는 document-changed를 내보내지 않는다. 그 경우에도
  // stale guard를 유지하기 위해 정확히 한 번 revision을 증가시킨다.
  if (documentRevision === revisionBeforeEdit) documentRevision += 1;
  return {
    ...context,
    documentRevision,
  };
}

function replaceTopLevelCellText(target: any, text: string): void {
  const paraCount = wasm.getCellParagraphCount(target.secIdx, target.paraIdx, target.controlIdx, target.cellIdx);
  if (paraCount > 0) {
    const lastParaIdx = paraCount - 1;
    const lastLen = wasm.getCellParagraphLength(target.secIdx, target.paraIdx, target.controlIdx, target.cellIdx, lastParaIdx);
    wasm.deleteRangeInCell(
      target.secIdx,
      target.paraIdx,
      target.controlIdx,
      target.cellIdx,
      0,
      0,
      lastParaIdx,
      lastLen,
    );
  }
  wasm.insertTextInCell(target.secIdx, target.paraIdx, target.controlIdx, target.cellIdx, 0, 0, text);
}

function normalizeCharStyleProps(props: Record<string, unknown>): Record<string, unknown> {
  const next = { ...props };
  const fontName = typeof next.fontName === 'string' ? next.fontName.trim() : '';
  if (fontName && next.fontId === undefined) {
    const fontId = wasm.findOrCreateFontId(fontName);
    if (fontId >= 0) {
      next.fontId = fontId;
    }
    delete next.fontName;
  }
  return next;
}

function applySelectionCharStyle(props: Record<string, unknown>): void {
  if (!inputHandler) throw new Error('에디터가 아직 준비되지 않았습니다');
  const selection = inputHandler.getSelection();
  if (!selection) {
    throw new Error('글자 서식을 적용할 선택 영역이 없습니다.');
  }
  const normalizedProps = normalizeCharStyleProps(props);
  const propsJson = JSON.stringify(normalizedProps);
  const { start, end } = selection;

  if (start.parentParaIndex !== undefined) {
    const sec = start.sectionIndex;
    const parentPara = start.parentParaIndex;
    const controlIdx = start.controlIndex!;
    const cellIdx = start.cellIndex!;
    const startPara = start.cellParaIndex ?? 0;
    const endPara = end.cellParaIndex ?? startPara;

    for (let paraIndex = startPara; paraIndex <= endPara; paraIndex += 1) {
      const from = paraIndex === startPara ? start.charOffset : 0;
      const to = paraIndex === endPara
        ? end.charOffset
        : wasm.getCellParagraphLength(sec, parentPara, controlIdx, cellIdx, paraIndex);
      if (to <= from) continue;
      wasm.applyCharFormatInCell(sec, parentPara, controlIdx, cellIdx, paraIndex, from, to, propsJson);
    }
    return;
  }

  for (let paragraphIndex = start.paragraphIndex; paragraphIndex <= end.paragraphIndex; paragraphIndex += 1) {
    const from = paragraphIndex === start.paragraphIndex ? start.charOffset : 0;
    const to = paragraphIndex === end.paragraphIndex ? end.charOffset : wasm.getParagraphLength(start.sectionIndex, paragraphIndex);
    if (to <= from) continue;
    wasm.applyCharFormat(start.sectionIndex, paragraphIndex, from, to, propsJson);
  }
}

function applySelectionParaStyle(props: Record<string, unknown>): void {
  if (!inputHandler) throw new Error('에디터가 아직 준비되지 않았습니다');
  const selection = inputHandler.getSelection();
  const cursor = inputHandler.getCursorPosition();
  if (!cursor) {
    throw new Error('문단 서식을 적용할 커서 위치를 찾을 수 없습니다.');
  }
  const range = selection ?? { start: cursor, end: cursor };
  const propsJson = JSON.stringify(props);

  if (range.start.parentParaIndex !== undefined) {
    wasm.applyParaFormatInCell(
      range.start.sectionIndex,
      range.start.parentParaIndex,
      range.start.controlIndex!,
      range.start.cellIndex!,
      range.start.cellParaIndex ?? 0,
      propsJson,
    );
    return;
  }

  for (let paragraphIndex = range.start.paragraphIndex; paragraphIndex <= range.end.paragraphIndex; paragraphIndex += 1) {
    wasm.applyParaFormat(range.start.sectionIndex, paragraphIndex, propsJson);
  }
}

function collectSelectedCellIndices(sec: number, parentPara: number, controlIdx: number): number[] {
  if (!inputHandler) return [];
  const range = inputHandler.getSelectedCellRange?.();
  if (!range) {
    const pos = inputHandler.getCursorPosition();
    return typeof pos?.cellIndex === 'number' ? [pos.cellIndex] : [];
  }

  const cells = wasm.getTableCellBboxes(sec, parentPara, controlIdx);
  return cells
    .filter((cell) => {
      const cellEndRow = cell.row + cell.rowSpan - 1;
      const cellEndCol = cell.col + cell.colSpan - 1;
      return cell.row <= range.endRow
        && cellEndRow >= range.startRow
        && cell.col <= range.endCol
        && cellEndCol >= range.startCol;
    })
    .map((cell) => cell.cellIdx);
}

function setCurrentCellProperties(props: Record<string, unknown>): void {
  if (!inputHandler) throw new Error('에디터가 아직 준비되지 않았습니다');
  const pos = inputHandler.getCursorPosition();
  if (pos.parentParaIndex === undefined || pos.controlIndex === undefined) {
    throw new Error('표 셀 내부에서만 셀 속성을 바꿀 수 있습니다.');
  }

  const cellIndices = collectSelectedCellIndices(pos.sectionIndex, pos.parentParaIndex, pos.controlIndex);
  if (!cellIndices.length) {
    throw new Error('속성을 바꿀 셀을 찾지 못했습니다.');
  }

  for (const cellIdx of cellIndices) {
    wasm.setCellProperties(pos.sectionIndex, pos.parentParaIndex, pos.controlIndex, cellIdx, props);
  }
}

function setCurrentTableProperties(props: Record<string, unknown>): void {
  if (!inputHandler) throw new Error('에디터가 아직 준비되지 않았습니다');
  const pos = inputHandler.getCursorPosition();
  if (pos.parentParaIndex === undefined || pos.controlIndex === undefined) {
    throw new Error('표 내부에서만 표 속성을 바꿀 수 있습니다.');
  }
  wasm.setTableProperties(pos.sectionIndex, pos.parentParaIndex, pos.controlIndex, props);
}

function collectTopLevelTableTargets(): Array<{ secIdx: number; paraIdx: number; controlIdx: number }> {
  const seen = new Set<string>();
  const targets: Array<{ secIdx: number; paraIdx: number; controlIdx: number }> = [];

  for (let pageIndex = 0; pageIndex < wasm.pageCount; pageIndex += 1) {
    const layouts = wasm.getPageControlLayout(pageIndex)?.controls ?? [];
    for (const item of layouts) {
      if (item.type !== 'table' || item.secIdx === undefined || item.paraIdx === undefined || item.controlIdx === undefined) {
        continue;
      }
      const key = `${item.secIdx}:${item.paraIdx}:${item.controlIdx}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({
        secIdx: item.secIdx,
        paraIdx: item.paraIdx,
        controlIdx: item.controlIdx,
      });
    }
  }

  return targets;
}

function getDocumentFontUsage(): any {
  const fonts = new Set<string>();
  const samples: Array<{ scope: string; fontFamily: string }> = [];
  const info = wasm.getDocumentInfo();
  const sectionCount = info.sectionCount ?? 1;

  for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
    const paragraphCount = wasm.getParagraphCount(sectionIndex);
    for (let paragraphIndex = 0; paragraphIndex < paragraphCount; paragraphIndex += 1) {
      const length = wasm.getParagraphLength(sectionIndex, paragraphIndex);
      if (length <= 0) continue;
      const props = wasm.getCharPropertiesAt(sectionIndex, paragraphIndex, 0);
      const fontFamily = props.fontFamily || props.fontFamilies?.find(Boolean);
      if (!fontFamily) continue;
      fonts.add(fontFamily);
      if (samples.length < 20) {
        samples.push({
          scope: `body:${sectionIndex}:${paragraphIndex}`,
          fontFamily,
        });
      }
    }
  }

  for (const table of collectTopLevelTableTargets()) {
    const dims = wasm.getTableDimensions(table.secIdx, table.paraIdx, table.controlIdx);
    for (let cellIdx = 0; cellIdx < dims.cellCount; cellIdx += 1) {
      const paraCount = wasm.getCellParagraphCount(table.secIdx, table.paraIdx, table.controlIdx, cellIdx);
      for (let cellParaIdx = 0; cellParaIdx < paraCount; cellParaIdx += 1) {
        const length = wasm.getCellParagraphLength(table.secIdx, table.paraIdx, table.controlIdx, cellIdx, cellParaIdx);
        if (length <= 0) continue;
        const props = wasm.getCellCharPropertiesAt(table.secIdx, table.paraIdx, table.controlIdx, cellIdx, cellParaIdx, 0);
        const fontFamily = props.fontFamily || props.fontFamilies?.find(Boolean);
        if (!fontFamily) continue;
        fonts.add(fontFamily);
        if (samples.length < 20) {
          samples.push({
            scope: `cell:${table.secIdx}:${table.paraIdx}:${table.controlIdx}:${cellIdx}:${cellParaIdx}`,
            fontFamily,
          });
        }
      }
    }
  }

  return {
    fonts: Array.from(fonts),
    samples,
    availableFonts: Array.from(REGISTERED_FONTS).sort((left, right) => left.localeCompare(right)),
    detectedOsFonts: Array.from(getDetectedOSFonts()).sort((left, right) => left.localeCompare(right)),
  };
}

function collectTopLevelTableSnapshot(pageIndex: number): any[] {
  const layouts = wasm.getPageControlLayout(pageIndex)?.controls ?? [];
  const seen = new Set<string>();
  const tables: any[] = [];

  for (const item of layouts) {
    if (item.type !== 'table' || item.secIdx === undefined || item.paraIdx === undefined || item.controlIdx === undefined) {
      continue;
    }
    const secIdx = item.secIdx;
    const paraIdx = item.paraIdx;
    const controlIdx = item.controlIdx;
    const key = `${item.secIdx}:${item.paraIdx}:${item.controlIdx}:${pageIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const cellBboxes = wasm.getTableCellBboxes(secIdx, paraIdx, controlIdx, pageIndex)
      .filter((cell) => cell.pageIndex === pageIndex);
    const dims = wasm.getTableDimensions(secIdx, paraIdx, controlIdx);
    const cells = cellBboxes.map((cell) => {
      const paraCount = wasm.getCellParagraphCount(secIdx, paraIdx, controlIdx, cell.cellIdx);
      const paragraphs: string[] = [];
      for (let p = 0; p < paraCount; p += 1) {
        const len = wasm.getCellParagraphLength(secIdx, paraIdx, controlIdx, cell.cellIdx, p);
        paragraphs.push(wasm.getTextInCell(secIdx, paraIdx, controlIdx, cell.cellIdx, p, 0, len));
      }
      const info = wasm.getCellInfo(secIdx, paraIdx, controlIdx, cell.cellIdx);
      const props = wasm.getCellProperties(secIdx, paraIdx, controlIdx, cell.cellIdx);
      return {
        cellIdx: cell.cellIdx,
        row: info.row,
        col: info.col,
        rowSpan: info.rowSpan,
        colSpan: info.colSpan,
        bbox: { x: cell.x, y: cell.y, w: cell.w, h: cell.h },
        text: paragraphs.join('\n').trim(),
        paragraphs,
        properties: props,
      };
    });

    tables.push({
      pageIndex,
      secIdx,
      paraIdx,
      controlIdx,
      bbox: { x: item.x, y: item.y, w: item.w, h: item.h },
      dimensions: dims,
      cells,
    });
  }

  return tables;
}

async function getFormSnapshot(includeImages = true): Promise<any> {
  const pages: any[] = [];
  let renderedImageCount = 0;
  const maxImagePages = 3;
  for (let pageIndex = 0; pageIndex < wasm.pageCount; pageIndex += 1) {
    const tables = collectTopLevelTableSnapshot(pageIndex);
    const page: any = {
      pageIndex,
      tables,
    };
    const shouldRenderImage =
      includeImages &&
      renderedImageCount < maxImagePages &&
      (pageIndex === 0 || tables.length > 0);

    if (shouldRenderImage) {
      const svg = wasm.renderPageSvg(pageIndex);
      page.image = await svgToPngDataUrl(svg);
      renderedImageCount += 1;
    }
    pages.push(page);
  }

  return {
    documentInfo: wasm.getDocumentInfo(),
    pages,
    fields: wasm.getFieldList(),
    bookmarks: wasm.getBookmarks(),
  };
}

async function getDocumentStructure(includeImages = false): Promise<any> {
  const info = wasm.getDocumentInfo();
  const sectionCount = info.sectionCount ?? 1;
  const sections: any[] = [];
  const pages: any[] = Array.from({ length: wasm.pageCount }, (_, pageIndex) => ({
    pageIndex,
    textPreview: '',
  }));

  for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
    const paragraphCount = wasm.getParagraphCount(sectionIndex);
    const paragraphs: any[] = [];

    for (let paragraphIndex = 0; paragraphIndex < paragraphCount; paragraphIndex += 1) {
      const length = wasm.getParagraphLength(sectionIndex, paragraphIndex);
      const rawText = length > 0 ? wasm.getTextRange(sectionIndex, paragraphIndex, 0, length) : '';
      const text = rawText.replace(/\s+/g, ' ').trim();
      const page = wasm.getPageOfPosition(sectionIndex, paragraphIndex);
      const pageIndex = page?.ok && typeof page.page === 'number' ? page.page : 0;
      if (text) {
        pages[pageIndex].textPreview = `${pages[pageIndex].textPreview} ${text}`.trim();
      }
      paragraphs.push({
        sectionIndex,
        paragraphIndex,
        pageIndex,
        text,
        length,
        isBlank: !text,
      });
    }

    sections.push({
      sectionIndex,
      paragraphCount,
      paragraphs,
    });
  }

  const outlinedPages: any[] = pages.map((page) => ({
    ...page,
    textPreview: page.textPreview.trim(),
  }));

  if (includeImages) {
    for (const page of outlinedPages.slice(0, 2)) {
      const svg = wasm.renderPageSvg(page.pageIndex);
      page.image = await svgToPngDataUrl(svg);
    }
  }

  return {
    documentInfo: info,
    sections,
    pages: outlinedPages,
    fields: wasm.getFieldList(),
    bookmarks: wasm.getBookmarks(),
  };
}

function buildTableCellStartPosition(target: any): any {
  return {
    sectionIndex: target.secIdx,
    paragraphIndex: 0,
    charOffset: 0,
    parentParaIndex: target.paraIdx,
    controlIndex: target.controlIdx,
    cellIndex: target.cellIdx,
    cellParaIndex: 0,
  };
}

function buildTableCellEndPosition(target: any): any {
  const paraCount = wasm.getCellParagraphCount(target.secIdx, target.paraIdx, target.controlIdx, target.cellIdx);
  const lastParaIndex = Math.max(0, paraCount - 1);
  const lastLength = wasm.getCellParagraphLength(target.secIdx, target.paraIdx, target.controlIdx, target.cellIdx, lastParaIndex);
  return {
    sectionIndex: target.secIdx,
    paragraphIndex: lastParaIndex,
    charOffset: lastLength,
    parentParaIndex: target.paraIdx,
    controlIndex: target.controlIdx,
    cellIndex: target.cellIdx,
    cellParaIndex: lastParaIndex,
  };
}

function selectTarget(target: any, mode: string = 'cursor'): boolean {
  if (!inputHandler || !target || typeof target !== 'object') {
    return false;
  }

  switch (target.kind) {
    case 'paragraph':
      if (mode === 'text') {
        return inputHandler.selectParagraph(target.sectionIndex, target.paragraphIndex);
      }
      return inputHandler.moveCursorTo({
        sectionIndex: target.sectionIndex,
        paragraphIndex: target.paragraphIndex,
        charOffset: 0,
      });
    case 'table':
      return inputHandler.selectTableObject(target.secIdx, target.paraIdx, target.controlIdx);
    case 'tableCell':
      if (mode === 'cell') {
        return inputHandler.selectTableCell(target.secIdx, target.paraIdx, target.controlIdx, target.cellIdx);
      }
      if (mode === 'text') {
        return inputHandler.selectRange(
          buildTableCellStartPosition(target),
          buildTableCellEndPosition(target),
        );
      }
      return inputHandler.moveCursorTo(buildTableCellStartPosition(target));
    default:
      return false;
  }
}

/** Citation navigation uses a persistent render overlay, not editor selection. */
function highlightTarget(target: any): boolean {
  if (!inputHandler || !target || typeof target !== 'object') return false;
  if (typeof target.sectionIndex !== 'number' || typeof target.paragraphIndex !== 'number') return false;
  if (target.kind === 'paragraph') return inputHandler.highlightParagraphBounds(target.sectionIndex, target.paragraphIndex);
  if (target.kind === 'table') return inputHandler.highlightTableBounds(target.sectionIndex, target.paragraphIndex);
  return false;
}

function resolveCursorTarget(target: any, currentPos: any): any {
  if (target && typeof target.sectionIndex === 'number' && typeof target.paragraphIndex === 'number') {
    return {
      sectionIndex: target.sectionIndex,
      paragraphIndex: target.paragraphIndex,
      charOffset: target.charOffset ?? 0,
    };
  }

  if (target && typeof target.pageIndex === 'number') {
    const pagePos = wasm.getPositionOfPage(target.pageIndex);
    if (pagePos?.ok) {
      return {
        sectionIndex: pagePos.sec,
        paragraphIndex: pagePos.para,
        charOffset: pagePos.charOffset ?? 0,
      };
    }
  }

  if (target?.query) {
    const result = wasm.searchText(
      target.query,
      currentPos?.sectionIndex ?? 0,
      currentPos?.paragraphIndex ?? 0,
      currentPos?.charOffset ?? 0,
      true,
      !!target.caseSensitive,
    );
    if (result?.found && typeof result.sec === 'number' && typeof result.para === 'number') {
      return {
        sectionIndex: result.sec,
        paragraphIndex: result.para,
        charOffset: result.charOffset ?? 0,
      };
    }
  }

  return currentPos;
}

function insertTextAtPosition(position: any, text: string): any {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!position) {
    throw new Error('삽입 위치가 비어 있습니다.');
  }

  if (position.parentParaIndex !== undefined) {
    if (position.cellPath?.length) {
      wasm.insertTextInCellByPath(position.sectionIndex, position.parentParaIndex, JSON.stringify(position.cellPath), position.charOffset, normalized);
    } else {
      wasm.insertTextInCell(
        position.sectionIndex,
        position.parentParaIndex,
        position.controlIndex,
        position.cellIndex,
        position.cellParaIndex ?? 0,
        position.charOffset,
        normalized,
      );
    }
  } else {
    wasm.insertText(position.sectionIndex, position.paragraphIndex, position.charOffset, normalized);
  }

  return {
    ...position,
    charOffset: (position.charOffset ?? 0) + normalized.length,
  };
}

function applyAiOperations(operations: any[]): any {
  if (!inputHandler) throw new Error('에디터가 아직 준비되지 않았습니다');

  inputHandler.executeOperation({
    kind: 'snapshot',
    operationType: 'ai-batch',
    operation: () => {
      let workingCursor = inputHandler!.getCursorPosition();

      for (const operation of operations ?? []) {
        if (!operation || typeof operation !== 'object') continue;

        switch (operation.type) {
          case 'selectTarget':
            selectTarget(operation.target, operation.mode ?? 'cursor');
            workingCursor = inputHandler!.getCursorPosition();
            break;
          case 'moveCursor':
            workingCursor = resolveCursorTarget(operation.target, workingCursor);
            if (workingCursor) {
              inputHandler!.moveCursorTo(workingCursor);
              workingCursor = inputHandler!.getCursorPosition();
            }
            break;
          case 'executeCommand':
            dispatcher.dispatch(operation.commandId, operation.params ?? {});
            workingCursor = inputHandler!.getCursorPosition();
            break;
          case 'applySelectionCharStyle':
            applySelectionCharStyle(operation.props ?? {});
            workingCursor = inputHandler!.getCursorPosition();
            break;
          case 'applySelectionParaStyle':
            applySelectionParaStyle(operation.props ?? {});
            workingCursor = inputHandler!.getCursorPosition();
            break;
          case 'setCurrentCellProperties':
            setCurrentCellProperties(operation.props ?? {});
            workingCursor = inputHandler!.getCursorPosition();
            break;
          case 'setCurrentTableProperties':
            setCurrentTableProperties(operation.props ?? {});
            workingCursor = inputHandler!.getCursorPosition();
            break;
          case 'replaceSelectionOrInsert':
            if (inputHandler!.getSelection()) {
              workingCursor = applyTextEditDirect(operation.text ?? '');
            } else {
              const basePosition = workingCursor ?? inputHandler!.getCursorPosition();
              workingCursor = insertTextAtPosition(basePosition, operation.text ?? '');
            }
            break;
          case 'insertAtCursor':
            workingCursor = insertTextAtPosition(workingCursor, operation.text ?? '');
            break;
          case 'replaceParagraph':
            replaceBodyParagraphText(operation.sectionIndex, operation.paragraphIndex, operation.text ?? '');
            workingCursor = {
              sectionIndex: operation.sectionIndex,
              paragraphIndex: operation.paragraphIndex,
              charOffset: (operation.text ?? '').length,
            };
            break;
          case 'fillTargetValue':
            fillFormValuesDirect([{ target: operation.target, value: operation.value ?? '' }]);
            break;
          case 'fillManyTargets':
            fillFormValuesDirect(operation.entries ?? []);
            break;
          default:
            console.warn('[applyAiOperations] unknown operation', operation);
        }
      }

      return workingCursor;
    },
  });

  return {
    ok: true,
    context: getSelectionContext(),
  };
}

function executeEditorCommand(commandId: string, params?: Record<string, unknown>): any {
  const ok = dispatcher.dispatch(commandId, params ?? {});
  return {
    ok,
    context: getSelectionContext(),
  };
}

function applySelectionCharStyleWithHistory(props: Record<string, unknown>): any {
  if (!inputHandler) throw new Error('에디터가 아직 준비되지 않았습니다');
  inputHandler.executeOperation({
    kind: 'snapshot',
    operationType: 'ai-selection-char-style',
    operation: () => {
      applySelectionCharStyle(props);
      return inputHandler!.getCursorPosition();
    },
  });
  return {
    ok: true,
    context: getSelectionContext(),
  };
}

function applySelectionParaStyleWithHistory(props: Record<string, unknown>): any {
  if (!inputHandler) throw new Error('에디터가 아직 준비되지 않았습니다');
  inputHandler.executeOperation({
    kind: 'snapshot',
    operationType: 'ai-selection-para-style',
    operation: () => {
      applySelectionParaStyle(props);
      return inputHandler!.getCursorPosition();
    },
  });
  return {
    ok: true,
    context: getSelectionContext(),
  };
}

function setCurrentCellPropertiesWithHistory(props: Record<string, unknown>): any {
  if (!inputHandler) throw new Error('에디터가 아직 준비되지 않았습니다');
  inputHandler.executeOperation({
    kind: 'snapshot',
    operationType: 'ai-cell-properties',
    operation: () => {
      setCurrentCellProperties(props);
      return inputHandler!.getCursorPosition();
    },
  });
  return {
    ok: true,
    context: getSelectionContext(),
  };
}

function setCurrentTablePropertiesWithHistory(props: Record<string, unknown>): any {
  if (!inputHandler) throw new Error('에디터가 아직 준비되지 않았습니다');
  inputHandler.executeOperation({
    kind: 'snapshot',
    operationType: 'ai-table-properties',
    operation: () => {
      setCurrentTableProperties(props);
      return inputHandler!.getCursorPosition();
    },
  });
  return {
    ok: true,
    context: getSelectionContext(),
  };
}

function fillFormValues(entries: Array<{ target: any; value: string }>, useHistory = true): any {
  if (!useHistory || !inputHandler) {
    fillFormValuesDirect(entries);
    inputHandler?.triggerAfterEdit();
    return { ok: true };
  }

  inputHandler.executeOperation({
    kind: 'snapshot',
    operationType: 'form-fill',
    operation: () => {
      fillFormValuesDirect(entries);
      return inputHandler!.getCursorPosition();
    },
  });

  return { ok: true };
}

initialize();

// ── iframe 연동 API (postMessage) ──
// 부모 페이지에서 postMessage로 에디터를 제어할 수 있다.
// 요청: { type: 'rhwp-request', id, method, params }
// 응답: { type: 'rhwp-response', id, result?, error? }
window.addEventListener('message', async (e) => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;

  // 기존 hwpctl-load 호환
  if (msg.type === 'hwpctl-load' && msg.data) {
    try {
      const bytes = new Uint8Array(msg.data);
      const docInfo = wasm.loadDocument(bytes, msg.fileName || 'document.hwp');
      await initializeDocument(docInfo, `${msg.fileName || 'document'} — ${docInfo.pageCount}페이지`);
      e.source?.postMessage({ type: 'rhwp-response', id: msg.id, result: { pageCount: docInfo.pageCount } }, { targetOrigin: '*' });
    } catch (err: any) {
      e.source?.postMessage({ type: 'rhwp-response', id: msg.id, error: err.message || String(err) }, { targetOrigin: '*' });
    }
    return;
  }

  // rhwp-request: 범용 API
  if (msg.type !== 'rhwp-request' || !msg.method) return;
  const { id, method, params } = msg;
  const reply = (result?: any, error?: string) => {
    e.source?.postMessage({ type: 'rhwp-response', id, result, error }, { targetOrigin: '*' });
  };

  try {
    switch (method) {
      case 'loadFile': {
        const bytes = new Uint8Array(params.data);
        const docInfo = wasm.loadDocument(bytes, params.fileName || 'document.hwp');
        await initializeDocument(
          docInfo,
          `${params.fileName || 'document'} — ${docInfo.pageCount}페이지`,
          {
            validationChoice: params.validationChoice === 'as-is' ? 'as-is' : 'prompt',
            readOnly: Boolean(params.readOnly),
          },
        );
        reply({ pageCount: docInfo.pageCount });
        break;
      }
      case 'createNewDocument':
        reply(await createNewDocument());
        break;
      case 'loadBlobUrl': {
        const response = await fetch(params.url);
        if (!response.ok) {
          throw new Error(`Blob fetch failed: ${response.status}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        const docInfo = wasm.loadDocument(bytes, params.fileName || 'document.hwp');
        await initializeDocument(docInfo, `${params.fileName || 'document'} — ${docInfo.pageCount}페이지`);
        reply({ pageCount: docInfo.pageCount });
        break;
      }
      case 'pageCount':
        reply(wasm.pageCount);
        break;
      case 'getPageSvg':
        reply(wasm.renderPageSvg(params.page ?? 0));
        break;
      case 'getPagePng': {
        const svg = wasm.renderPageSvg(params.page ?? 0);
        reply(await svgToPngDataUrl(svg));
        break;
      }
      case 'getDocumentInfo':
        reply(wasm.getDocumentInfo());
        break;
      case 'getSourceFormat':
        reply(wasm.getSourceFormat());
        break;
      case 'getDocumentStructure':
        reply(await getDocumentStructure(!!params.includeImages));
        break;
      case 'getSelectionContext':
        reply(getSelectionContext());
        break;
      case 'getSelection':
        reply(getSelectionContext());
        break;
      case 'getEditorModeSnapshot':
        reply(getEditorModeSnapshot());
        break;
      case 'getSelectionStyleSnapshot':
        reply(getSelectionStyleSnapshot());
        break;
      case 'getToolCatalog':
        reply({
          commands: getCommandCatalog(),
          primitives: getPrimitiveToolCatalog(),
        });
        break;
      case 'getDocumentFontUsage':
        reply(getDocumentFontUsage());
        break;
      case 'getCursorPosition':
        reply(inputHandler?.getCursorPosition() ?? null);
        break;
      case 'executeCommand':
        reply(executeEditorCommand(params.commandId ?? '', params.params ?? {}));
        break;
      case 'selectTarget':
        reply({
          ok: selectTarget(params.target ?? {}, params.mode ?? 'cursor'),
          context: getSelectionContext(),
        });
        break;
      case 'highlightTarget':
        reply({
          ok: highlightTarget(params.target ?? {}),
          context: getSelectionContext(),
        });
        break;
      case 'applySelectionCharStyle':
        reply(applySelectionCharStyleWithHistory(params.props ?? {}));
        break;
      case 'applySelectionParaStyle':
        reply(applySelectionParaStyleWithHistory(params.props ?? {}));
        break;
      case 'setCurrentCellProperties':
        reply(setCurrentCellPropertiesWithHistory(params.props ?? {}));
        break;
      case 'setCurrentTableProperties':
        reply(setCurrentTablePropertiesWithHistory(params.props ?? {}));
        break;
      case 'moveCursor':
        reply(inputHandler?.moveCursorTo(resolveCursorTarget(params.target ?? {}, inputHandler?.getCursorPosition())) ?? false);
        break;
      case 'applyTextEdit':
        reply(applyTextEdit(params.text ?? ''));
        break;
      case 'replaceSelection':
        reply(replaceSelectionWithGuard(params ?? {}));
        break;
      case 'applyAiOperations':
        reply(applyAiOperations(params.operations ?? []));
        break;
      case 'getFormSnapshot':
        reply(await getFormSnapshot(params.includeImages !== false));
        break;
      case 'searchText':
        reply(wasm.searchText(params.query ?? '', 0, 0, 0, true, !!params.caseSensitive));
        break;
      case 'fillFormValues':
        reply(fillFormValues(params.entries ?? [], params.useHistory !== false));
        break;
      case 'undo':
        inputHandler?.performUndo();
        reply({ ok: true, context: getSelectionContext() });
        break;
      case 'redo':
        inputHandler?.performRedo();
        reply({ ok: true, context: getSelectionContext() });
        break;
      case 'exportHwp':
        reply(Array.from(wasm.exportHwp()));
        break;
      case 'exportHwpx':
        reply(Array.from(wasm.exportHwpx()));
        break;
      case 'ready':
        reply(appReady);
        break;
      default:
        reply(undefined, `Unknown method: ${method}`);
    }
  } catch (err: any) {
    reply(undefined, err.message || String(err));
  }
});
