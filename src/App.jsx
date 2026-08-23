import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo
} from 'react';
import { 
  Brain, Plus, Minus, ArrowRight, Sparkles, X, GitBranch, 
  FileText, Bold, Italic, 
  List, PanelRightClose, PanelRightOpen, ZoomIn, ZoomOut, 
  RotateCcw, Trash2, Download, Upload, Folder, FolderOpen, 
  FileImage, FileCode, Eye, ChevronLeft, ChevronRight, GripHorizontal,
  Copy, Check, Clipboard, ClipboardPaste, BookOpen, ChevronUp, ChevronDown,
  Move, Maximize2, Minimize2, Layers, AlertTriangle, Undo2, Redo2, LayoutGrid,
  CheckSquare, MousePointer, LocateFixed, Sun, Moon
} from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import './App.css';
import { BASE_WORKSPACE_PADDING, MAX_WORKSPACE_PADDING, SAFETY_MARGIN } from './constants/workspace';
import { 
  cloneMindMapState, getChildLogicalSide, getChildrenByDirection, 
  applyFormattedChildrenToTree, 
  applyMultipleFormattedChildrenToTree, ensureNodePositions, 
  addNodeInDirection, updateNodePositionInTree, deleteNodeFromTree, 
  updateNodeInTree, findNodeById, isLeafNode, 
  updateMultipleNodePositionsInTree, deleteMultipleNodesFromTree, 
  updateMultipleNodesText, findParentNode, getMultiSelectionFormatGroups, 
  getVisibleNodes, getVisibleConnections
} from './utils/treeUtils';
import { computeFormattedGroupPositions } from './utils/layoutUtils';
import { formatFileSize, readClipboardAsFiles } from './utils/fileUtils';
import { calculateConnectorPath } from './utils/geometryUtils';
import RichTextEditor from './components/RichTextEditor';
import NodePhotosManager from './components/NodePhotosManager';
import FloatingMediaWindow from './components/FloatingMediaWindow';
import PdfViewer from './components/PdfViewer';

import FilePreviewModal from './components/FilePreviewModal';
import MindMapNode from './components/MindMapNode';

// Configure PDF.js Worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();


export default function ThoughtFlowApp() {
  const [view, setView] = useState('welcome');
  const [inputText, setInputText] = useState('');
  const [treeData, setTreeData] = useState(null);
  const [activeNode, setActiveNode] = useState(null);
  const [newThoughtText, setNewThoughtText] = useState('');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Intercept browser refresh/reload when there are unsaved changes
  useEffect(() => {
    if (!hasUnsavedChanges) return;

    const handleBeforeUnload = (e) => {
      e.preventDefault();
      // Required for cross-browser standard confirmation dialog
      e.returnValue = 'Your changes will not be saved. Do you want to reload?';
      return 'Your changes will not be saved. Do you want to reload?';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [hasUnsavedChanges]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [collapsedNodeIds, setCollapsedNodeIds] = useState(new Set());
    
   const [dimensionsMap, setDimensionsMap] = useState({});
   const dimensionsMapRef = useRef({});
    
  
  const [sidebarTab, setSidebarTab] = useState('notes'); // 'notes' | 'photos'
  const [sidebarWidth, setSidebarWidth] = useState(384); // Resizable Node Inspector width
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const zoomLevelRef = useRef(1);
  useEffect(() => {
    zoomLevelRef.current = zoomLevel;
  }, [zoomLevel]);

  const [activeSection, setActiveSection] = useState('inspector'); // 'inspector' | 'preview' | 'importedFiles' | 'canvas'

  // When Node Inspector is closed in normal mode, the effective active section is always 'importedFiles' (or 'preview')
  const effectiveActiveSection = (!isSidebarOpen && activeSection === 'inspector') ? 'importedFiles' : activeSection;

  // Read Mode State: focus purely on nodes and inspector notes while detaching media into a floating window
  const [isReadMode, setIsReadMode] = useState(false);
  const [isFloatingMediaOpen, setIsFloatingMediaOpen] = useState(true);

  // Theme State: Light / Dark Mode toggle with localStorage persistence
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const saved = localStorage.getItem('thoughtflow-theme');
    return saved !== 'light'; // default to dark
  });

  useEffect(() => {
    const theme = isDarkMode ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('thoughtflow-theme', theme);
  }, [isDarkMode]);

  const toggleTheme = useCallback(() => {
    setIsDarkMode(prev => !prev);
  }, []);

  // File Upload and Preview states
  const [importedFiles, setImportedFiles] = useState([]);
  const [previewFile, setPreviewFile] = useState(null);
  const [previewWidth, setPreviewWidth] = useState(480);
  const [isFolderMenuOpen, setIsFolderMenuOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef(null);

  // Persistent File View States (remembers scroll position, page, and zoom per file)
  const fileViewStatesRef = useRef({});
  const getFileViewState = (fileId) => {
    if (!fileId) return {};
    return fileViewStatesRef.current[fileId] || {};
  };
  const saveFileViewState = (fileId, updates) => {
    if (!fileId) return;
    fileViewStatesRef.current[fileId] = {
      ...(fileViewStatesRef.current[fileId] || {}),
      ...updates
    };
  };

  // Draggable Thought Creation Box state (topmost element)
  const [thoughtBoxPos, setThoughtBoxPos] = useState(null);
  const [isThoughtBoxCollapsed, setIsThoughtBoxCollapsed] = useState(false);
  const [isDraggingHex, setIsDraggingHex] = useState(false);
  const thoughtBoxPosRef = useRef(null);
  const thoughtBoxRef = useRef(null);
  const isDraggingThoughtBox = useRef(false);
  const thoughtBoxDragOffsetRef = useRef({ x: 0, y: 0 });
  const thoughtBoxRafRef = useRef(null);
  const hexDragStateRef = useRef(null);

  // Canvas dragging state & persistent viewport view state
  const [isCanvasDragging, setIsCanvasDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const canvasRef = useRef(null);
  const canvasViewStateRef = useRef({ scrollLeft: null, scrollTop: null });

  // Dynamic Canvas Workspace Padding State (monotonically expands as nodes move or canvas pans)
  const [workspacePadding, setWorkspacePadding] = useState(BASE_WORKSPACE_PADDING);
  const workspacePaddingRef = useRef(BASE_WORKSPACE_PADDING);

  // Refs to hold pending layout adjustments for zoom and workspace padding
  const pendingZoomScrollRef = useRef(null);
  const pendingPaddingCompensationRef = useRef(null);

  // Synchronize canvas scroll position immediately upon DOM resize commit of zoomLevel
  useLayoutEffect(() => {
    if (pendingZoomScrollRef.current && canvasRef.current) {
      const { scrollLeft, scrollTop } = pendingZoomScrollRef.current;
      pendingZoomScrollRef.current = null;
      const el = canvasRef.current;
      const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
      const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      const clampedX = Math.max(0, Math.min(maxScrollLeft, Math.round(scrollLeft)));
      const clampedY = Math.max(0, Math.min(maxScrollTop, Math.round(scrollTop)));
      el.scrollLeft = clampedX;
      el.scrollTop = clampedY;
      canvasViewStateRef.current = {
        scrollLeft: clampedX,
        scrollTop: clampedY
      };
    }
  }, [zoomLevel]);

  // Synchronize canvas scroll position when workspace padding dynamically expands
  useLayoutEffect(() => {
    if (pendingPaddingCompensationRef.current && canvasRef.current) {
      const { deltaLeft, deltaTop, zoom } = pendingPaddingCompensationRef.current;
      pendingPaddingCompensationRef.current = null;
      const el = canvasRef.current;
      const addScrollX = deltaLeft * zoom;
      const addScrollY = deltaTop * zoom;
      el.scrollLeft += addScrollX;
      el.scrollTop += addScrollY;
      canvasViewStateRef.current = {
        scrollLeft: el.scrollLeft,
        scrollTop: el.scrollTop
      };
    }
  }, [workspacePadding]);

  // Application-Level Mind-Map Undo/Redo History Manager
  const MAX_HISTORY = 60;
  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const isHistoryActionRef = useRef(false);
  const dragStartSnapshotRef = useRef(null);
  const pendingTextEditSnapshotRef = useRef(null);
  const textEditDebounceTimerRef = useRef(null);

  const pushSnapshotToUndo = useCallback((snapshot) => {
    if (!snapshot || isHistoryActionRef.current) return;
    undoStackRef.current.push(snapshot);
    if (undoStackRef.current.length > MAX_HISTORY) {
      undoStackRef.current.shift();
    }
    redoStackRef.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }, []);

  const flushPendingTextEditHistory = useCallback(() => {
    if (textEditDebounceTimerRef.current) {
      clearTimeout(textEditDebounceTimerRef.current);
      textEditDebounceTimerRef.current = null;
    }
    if (pendingTextEditSnapshotRef.current) {
      pushSnapshotToUndo(pendingTextEditSnapshotRef.current);
      pendingTextEditSnapshotRef.current = null;
    }
  }, [pushSnapshotToUndo]);

  const handleUndo = useCallback(() => {
    // Commit any uncommitted text editing in flight before undoing
    if (textEditDebounceTimerRef.current) {
      clearTimeout(textEditDebounceTimerRef.current);
      textEditDebounceTimerRef.current = null;
    }
    if (pendingTextEditSnapshotRef.current) {
      const beforeState = pendingTextEditSnapshotRef.current;
      pendingTextEditSnapshotRef.current = null;
      undoStackRef.current.push(beforeState);
    }

    if (undoStackRef.current.length === 0 || !treeData) return;

    isHistoryActionRef.current = true;
    try {
      const currentSnapshot = cloneMindMapState(treeData, collapsedNodeIds);
      if (currentSnapshot) {
        redoStackRef.current.push(currentSnapshot);
        if (redoStackRef.current.length > MAX_HISTORY) {
          redoStackRef.current.shift();
        }
      }

      const previousSnapshot = undoStackRef.current.pop();
      if (previousSnapshot) {
        const restoredTree = previousSnapshot.treeData;
        const restoredCollapsed = new Set(previousSnapshot.collapsedNodeIds || []);
        
        setTreeData(restoredTree);
        setCollapsedNodeIds(restoredCollapsed);
        
        setActiveNode(prev => {
          if (!prev || !restoredTree) return restoredTree;
          const matchingNode = findNodeById(restoredTree, prev.id);
          return matchingNode || restoredTree;
        });
        
        setHasUnsavedChanges(true);
      }

      setCanUndo(undoStackRef.current.length > 0);
      setCanRedo(redoStackRef.current.length > 0);
    } finally {
      setTimeout(() => {
        isHistoryActionRef.current = false;
      }, 0);
    }
  }, [treeData, collapsedNodeIds]);

  const handleRedo = useCallback(() => {
    if (redoStackRef.current.length === 0 || !treeData) return;

    isHistoryActionRef.current = true;
    try {
      const currentSnapshot = cloneMindMapState(treeData, collapsedNodeIds);
      if (currentSnapshot) {
        undoStackRef.current.push(currentSnapshot);
        if (undoStackRef.current.length > MAX_HISTORY) {
          undoStackRef.current.shift();
        }
      }

      const nextSnapshot = redoStackRef.current.pop();
      if (nextSnapshot) {
        const restoredTree = nextSnapshot.treeData;
        const restoredCollapsed = new Set(nextSnapshot.collapsedNodeIds || []);
        
        setTreeData(restoredTree);
        setCollapsedNodeIds(restoredCollapsed);
        
        setActiveNode(prev => {
          if (!prev || !restoredTree) return restoredTree;
          const matchingNode = findNodeById(restoredTree, prev.id);
          return matchingNode || restoredTree;
        });
        
        setHasUnsavedChanges(true);
      }

      setCanUndo(undoStackRef.current.length > 0);
      setCanRedo(redoStackRef.current.length > 0);
    } finally {
      setTimeout(() => {
        isHistoryActionRef.current = false;
      }, 0);
    }
  }, [treeData, collapsedNodeIds]);

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => {
      if (textEditDebounceTimerRef.current) {
        clearTimeout(textEditDebounceTimerRef.current);
      }
    };
  }, []);

  // Multi-Node Selection State
  const [selectedNodeIds, setSelectedNodeIds] = useState(new Set());
  const selectedNodeIdsRef = useRef(new Set());
  const dragJustFinishedRef = useRef(false);
  const [isCustomSelectMode, setIsCustomSelectMode] = useState(false);
  const [isShiftSelecting, setIsShiftSelecting] = useState(false);
  const [isSelectPopoverOpen, setIsSelectPopoverOpen] = useState(false);

  // File-Explorer Style Box Selection State
  const [selectionBox, setSelectionBox] = useState(null); // { startX, startY, currentX, currentY }
  const isBoxSelectingRef = useRef(false);
  const boxSelectStartRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    selectedNodeIdsRef.current = selectedNodeIds;
  }, [selectedNodeIds]);

  // Global Shift Key Listener for Selection Tool Cursor Mode
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Shift') {
        setIsShiftSelecting(true);
      }
    };
    const handleKeyUp = (e) => {
      if (e.key === 'Shift') {
        setIsShiftSelecting(false);
      }
    };
    const handleBlur = () => {
      setIsShiftSelecting(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  // Toggle "mindmap-selection-mode" CSS class on documentElement for crosshair cursor
  useEffect(() => {
    if (isCustomSelectMode || isShiftSelecting) {
      document.documentElement.classList.add('mindmap-selection-mode');
    } else {
      document.documentElement.classList.remove('mindmap-selection-mode');
    }
    return () => {
      document.documentElement.classList.remove('mindmap-selection-mode');
    };
  }, [isCustomSelectMode, isShiftSelecting]);

  // Click outside to close select popover
  useEffect(() => {
    const handleClickOutsideSelect = (e) => {
      if (isSelectPopoverOpen && !e.target.closest('.select-menu-container')) {
        setIsSelectPopoverOpen(false);
      }
    };
    window.addEventListener('mousedown', handleClickOutsideSelect);
    return () => window.removeEventListener('mousedown', handleClickOutsideSelect);
  }, [isSelectPopoverOpen]);

  // Check if main root node has any direct child nodes
  const rootHasAnyChildren = useMemo(() => {
    if (!treeData) return false;
    const hasRight = Array.isArray(treeData.rightChildren) && treeData.rightChildren.length > 0;
    const hasBottom = Array.isArray(treeData.children) && treeData.children.length > 0;
    return hasRight || hasBottom;
  }, [treeData]);

  // Directional eligibility computation for currently active parent node
  const currentParentForSelection = activeNode && treeData ? findNodeById(treeData, activeNode.id) : null;

  const selectionEligibility = useMemo(() => {
    if (!currentParentForSelection) {
      return {
        hasRight: false,
        hasBottom: false
      };
    }
    const hasRight = Array.isArray(currentParentForSelection.rightChildren) && currentParentForSelection.rightChildren.length > 0;
    const hasBottom = Array.isArray(currentParentForSelection.children) && currentParentForSelection.children.length > 0;

    return {
      hasRight,
      hasBottom
    };
  }, [currentParentForSelection]);

  // Multi-Selection Actions: Select Right, Select Bottom, Custom
  const handleSelectRight = () => {
    if (!activeNode || !treeData) return;
    const currentParent = findNodeById(treeData, activeNode.id);
    if (!currentParent) return;
    const leaves = (currentParent.rightChildren || []).filter(c => getChildLogicalSide(c, true) === 'right' && isLeafNode(c));
    if (leaves.length === 0) return;
    const nextSet = new Set(leaves.map(c => c.id));
    selectedNodeIdsRef.current = nextSet;
    setSelectedNodeIds(nextSet);
    setActiveNode(leaves[0]);
    setIsSelectPopoverOpen(false);
  };

  const handleSelectBottom = () => {
    if (!activeNode || !treeData) return;
    const currentParent = findNodeById(treeData, activeNode.id);
    if (!currentParent) return;
    const leaves = (currentParent.children || []).filter(c => getChildLogicalSide(c, false) === 'down' && isLeafNode(c));
    if (leaves.length === 0) return;
    const nextSet = new Set(leaves.map(c => c.id));
    selectedNodeIdsRef.current = nextSet;
    setSelectedNodeIds(nextSet);
    setActiveNode(leaves[0]);
    setIsSelectPopoverOpen(false);
  };

  const handleSelectCustom = () => {
    setIsCustomSelectMode(true);
    setIsSelectPopoverOpen(false);
  };

  const handleCancelCustomMode = () => {
    setIsCustomSelectMode(false);
  };

  // Bulk update text for multi-selection
  const handleBulkUpdateText = useCallback((newText) => {
    if (!treeData || selectedNodeIds.size === 0) return;
    if (!pendingTextEditSnapshotRef.current) {
      pendingTextEditSnapshotRef.current = cloneMindMapState(treeData, collapsedNodeIds);
    }
    if (textEditDebounceTimerRef.current) {
      clearTimeout(textEditDebounceTimerRef.current);
    }
    setTreeData(prev => updateMultipleNodesText(prev, selectedNodeIds, newText));
    setActiveNode(prev => (prev ? { ...prev, text: newText } : prev));
    setHasUnsavedChanges(true);

    textEditDebounceTimerRef.current = setTimeout(() => {
      flushPendingTextEditHistory();
    }, 800);
  }, [treeData, selectedNodeIds, collapsedNodeIds, flushPendingTextEditHistory]);

  // Bulk delete selected leaf nodes
  const handleBulkDeleteNodes = useCallback(() => {
    if (!treeData || selectedNodeIds.size === 0) return;
    flushPendingTextEditHistory();
    pushSnapshotToUndo(cloneMindMapState(treeData, collapsedNodeIds));

    const newTree = deleteMultipleNodesFromTree(treeData, selectedNodeIds);
    setTreeData(newTree);
    setSelectedNodeIds(new Set());
    setActiveNode(newTree);
    setHasUnsavedChanges(true);
  }, [treeData, selectedNodeIds, collapsedNodeIds, pushSnapshotToUndo, flushPendingTextEditHistory]);

  // Format feature state (manual layout organizer for children in Left/Right/Up/Down directions)
  const [isFormatPopoverOpen, setIsFormatPopoverOpen] = useState(false);
  const [formatDirectionState, setFormatDirection] = useState('right');
  const [formatLayout, setFormatLayout] = useState('list'); // 'list' | 'compact'

  const isMultiSelection = selectedNodeIds.size >= 2;
  const multiFormatGroups = useMemo(() => {
    if (!isMultiSelection || !treeData) {
      return { isMulti: false, validGroups: [], hasValidGroups: false, totalValidNodesCount: 0, totalSelectedCount: 0 };
    }
    return getMultiSelectionFormatGroups(treeData, selectedNodeIds);
  }, [isMultiSelection, treeData, selectedNodeIds]);

  const currentParentForFormat = useMemo(() => {
    if (isMultiSelection) {
      return multiFormatGroups.validGroups[0]?.parent || null;
    }
    return activeNode && treeData ? findNodeById(treeData, activeNode.id) : null;
  }, [isMultiSelection, multiFormatGroups, activeNode, treeData]);

  const childGroups = useMemo(() => {
    return getChildrenByDirection(currentParentForFormat);
  }, [currentParentForFormat]);

  const hasEnoughChildren = useMemo(() => {
    if (isMultiSelection) {
      return multiFormatGroups.hasValidGroups;
    }
    return (
      childGroups.right.length >= 2 ||
      childGroups.down.length >= 2
    );
  }, [isMultiSelection, multiFormatGroups, childGroups]);

  // Derived effective format direction (first eligible direction if current is not eligible, restricted to 'right' and 'down')
  const formatDirection = useMemo(() => {
    if (isMultiSelection) {
      return multiFormatGroups.validGroups[0]?.direction || 'right';
    }
    if (formatDirectionState === 'right' || formatDirectionState === 'down') {
      if (childGroups[formatDirectionState]?.length >= 2) {
        return formatDirectionState;
      }
    }
    const firstEligible = (['right', 'down']).find(d => childGroups[d]?.length >= 2);
    return firstEligible || (formatDirectionState === 'down' ? 'down' : 'right');
  }, [isMultiSelection, multiFormatGroups, childGroups, formatDirectionState]);

  // Click outside to close format popover
  useEffect(() => {
    const handleClickOutsideFormat = (e) => {
      if (isFormatPopoverOpen && !e.target.closest('.format-menu-container')) {
        setIsFormatPopoverOpen(false);
      }
    };
    window.addEventListener('mousedown', handleClickOutsideFormat);
    return () => window.removeEventListener('mousedown', handleClickOutsideFormat);
  }, [isFormatPopoverOpen]);

  // Execute Format Layout using persistent logical side
  const handleExecuteFormat = useCallback((direction, layout) => {
    if (!treeData) return;
    const dimMap = dimensionsMapRef.current || dimensionsMap;

    if (selectedNodeIds.size >= 2) {
      const info = getMultiSelectionFormatGroups(treeData, selectedNodeIds);
      if (!info.hasValidGroups) return;

      flushPendingTextEditHistory();
      pushSnapshotToUndo(cloneMindMapState(treeData, collapsedNodeIds));

      const combinedUpdates = {};
      info.validGroups.forEach(group => {
        const groupUpdates = computeFormattedGroupPositions(
          group.parent,
          group.items,
          group.direction,
          layout,
          dimMap
        );
        Object.assign(combinedUpdates, groupUpdates);
      });

      const newTree = applyMultipleFormattedChildrenToTree(treeData, combinedUpdates);
      setTreeData(newTree);
      setHasUnsavedChanges(true);
      setIsFormatPopoverOpen(false);
      return;
    }

    // Single parent node format
    if (!activeNode) return;
    const currentParent = findNodeById(treeData, activeNode.id);
    if (!currentParent) return;
    const groups = getChildrenByDirection(currentParent);
    const items = [...(groups[direction] || [])];
    if (items.length < 2) return;

    // Flush any pending text edit first
    flushPendingTextEditHistory();

    // Push ONE snapshot to undo stack
    pushSnapshotToUndo(cloneMindMapState(treeData, collapsedNodeIds));

    const updatedChildrenMap = computeFormattedGroupPositions(
      currentParent,
      items,
      direction,
      layout,
      dimMap
    );

    const newTree = applyFormattedChildrenToTree(treeData, currentParent.id, updatedChildrenMap);
    setTreeData(newTree);
    const updatedParent = findNodeById(newTree, currentParent.id);
    if (updatedParent && selectedNodeIds.size < 2) {
      setActiveNode(updatedParent);
    }
    setHasUnsavedChanges(true);
    setIsFormatPopoverOpen(false);
  }, [selectedNodeIds, activeNode, treeData, collapsedNodeIds, dimensionsMap, pushSnapshotToUndo, flushPendingTextEditHistory]);

  // Active Node Creation Direction State: 'bottom' (vertical child) | 'right' (horizontal sibling)
  const [activeCreationDirection, setActiveCreationDirection] = useState('bottom');

  const treeContainerRef = useRef(null);
  const activeDragNodeRef = useRef(null);
  const [draggingNodeId, setDraggingNodeId] = useState(null);
  const [liveDragOffset, setLiveDragOffset] = useState({ dx: 0, dy: 0 });
  const dragRafIdRef = useRef(null);
  

  const handleMeasureDimensions = useCallback((nodeId, width, height) => {
    if (!nodeId || width <= 0 || height <= 0) return;
    setDimensionsMap(prev => {
      const existing = prev[nodeId];
      if (existing && existing.width === width && existing.height === height) {
        return prev;
      }
      const next = { ...prev, [nodeId]: { width, height } };
      dimensionsMapRef.current = next;
      return next;
    });
  }, []);

  // Preset data matching learning React structure with free-form initial coordinates
  const reactPresetTree = {
    id: 'root', 
    text: 'React', 
    notes: '<h3>React Fundamentals</h3><p>A declarative, efficient, and flexible JavaScript library for building user interfaces.</p><ul><li>Component-Based Architecture</li><li>Virtual DOM for fast rendering</li><li>Unidirectional data flow</li></ul>', 
    drawing: null,
    x: 650,
    y: 260,
    children: [
      { 
        id: 'js', 
        text: 'JavaScript', 
        notes: '<p>Core language features required for React development.</p><ul><li>ES6 Modules (import/export)</li><li>Destructuring & Arrow functions</li><li>Promises and Async/Await</li></ul>', 
        drawing: null, 
        x: 350,
        y: 460,
        children: [
          { 
            id: 'proj', 
            text: 'Projects', 
            notes: '<p>Hands-on project ideas to practice your knowledge.</p>', 
            drawing: null, 
            x: 160,
            y: 640,
            children: [
              { id: 'port', text: 'Portfolio App', notes: '', drawing: null, x: 160, y: 800, children: [] }
            ]
          }
        ]
      },
      { 
        id: 'hooks', 
        text: 'Hooks', 
        notes: '<p>React Hooks let you use state and lifecycle features from function components.</p><ul><li><strong>useState:</strong> State management</li><li><strong>useEffect:</strong> Side effects & lifecycle</li><li><strong>useRef:</strong> Mutable references</li></ul>', 
        drawing: null, 
        x: 650,
        y: 480,
        children: [] 
      },
      { 
        id: 'dom', 
        text: 'Virtual DOM', 
        notes: '<p>In-memory representation of real DOM elements to compute minimal updates efficiently.</p>', 
        drawing: null, 
        x: 950,
        y: 460,
        children: [] 
      }
    ]
  };

  // Node collapse / expand state: Set of collapsed parent node IDs
  

  const handleToggleCollapse = useCallback((nodeId) => {
    if (!nodeId || !treeData) return;
    flushPendingTextEditHistory();
    pushSnapshotToUndo(cloneMindMapState(treeData, collapsedNodeIds));
    setCollapsedNodeIds(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
    setHasUnsavedChanges(true);
  }, [treeData, collapsedNodeIds, pushSnapshotToUndo, flushPendingTextEditHistory]);

  // Dynamic SVG Mind-Map Curved Connectors computation (respects collapsed branches)
  const allNodes = useMemo(() => getVisibleNodes(treeData, collapsedNodeIds), [treeData, collapsedNodeIds]);
  const allConnections = useMemo(() => getVisibleConnections(treeData, collapsedNodeIds), [treeData, collapsedNodeIds]);

  const allNodesRef = useRef(allNodes);
  const treeDataRef = useRef(treeData);

  useEffect(() => {
    allNodesRef.current = allNodes;
  }, [allNodes]);

  useEffect(() => {
    treeDataRef.current = treeData;
  }, [treeData]);

  // Helper to dynamically expand workspace padding when nodes approach boundaries (safely bounded)
  const expandWorkspaceForBounds = useCallback((nodes, dimMap = {}) => {
    // Never expand workspace or modify scroll positions during an active node drag
    if (activeDragNodeRef.current) return;
    if (!nodes || nodes.length === 0) return;
    
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    nodes.forEach(n => {
      if (!n) return;
      const nx = typeof n.x === 'number' ? n.x : 650;
      const ny = typeof n.y === 'number' ? n.y : 260;
      const nw = (dimMap && dimMap[n.id]?.width) || 200;
      const nh = (dimMap && dimMap[n.id]?.height) || 56;
      if (nx < minX) minX = nx;
      if (ny < minY) minY = ny;
      if (nx + nw > maxX) maxX = nx + nw;
      if (ny + nh > maxY) maxY = ny + nh;
    });

    if (!Number.isFinite(minX)) return;

    const SAFETY_MARGIN = 400;
    const current = workspacePaddingRef.current;

    const reqLeft = minX < 0 
      ? Math.min(MAX_WORKSPACE_PADDING, Math.max(current.left, BASE_WORKSPACE_PADDING.left + Math.ceil(Math.abs(minX)) + SAFETY_MARGIN))
      : current.left;
    const reqTop = minY < 0 
      ? Math.min(MAX_WORKSPACE_PADDING, Math.max(current.top, BASE_WORKSPACE_PADDING.top + Math.ceil(Math.abs(minY)) + SAFETY_MARGIN))
      : current.top;
    const reqRight = maxX > 4800 
      ? Math.min(MAX_WORKSPACE_PADDING, Math.max(current.right, BASE_WORKSPACE_PADDING.right + Math.ceil(maxX - 4800) + SAFETY_MARGIN))
      : current.right;
    const reqBottom = maxY > 3600 
      ? Math.min(MAX_WORKSPACE_PADDING, Math.max(current.bottom, BASE_WORKSPACE_PADDING.bottom + Math.ceil(maxY - 3600) + SAFETY_MARGIN))
      : current.bottom;

    const deltaLeft = reqLeft - current.left;
    const deltaTop = reqTop - current.top;
    const deltaRight = reqRight - current.right;
    const deltaBottom = reqBottom - current.bottom;

    if (deltaLeft > 0 || deltaTop > 0 || deltaRight > 0 || deltaBottom > 0) {
      const nextPadding = {
        left: reqLeft,
        top: reqTop,
        right: reqRight,
        bottom: reqBottom
      };
      workspacePaddingRef.current = nextPadding;
      if (deltaLeft > 0 || deltaTop > 0) {
        pendingPaddingCompensationRef.current = {
          deltaLeft,
          deltaTop,
          zoom: zoomLevelRef.current || 1
        };
      }
      setWorkspacePadding(nextPadding);
    }
  }, []);

  // Keep workspace dynamically expanded as nodes change (deferred during drag)
  useEffect(() => {
    if (allNodes.length > 0 && !activeDragNodeRef.current) {
      expandWorkspaceForBounds(allNodes, dimensionsMap);
    }
  }, [allNodes, dimensionsMap, expandWorkspaceForBounds]);

  // Node Drag Handler (Mousedown on node card starts drag)
  const handleNodeMouseDown = useCallback((e, node) => {
    if (e.target.closest('button.group\\/btn, [title*="Open"], [title*="Create"]')) {
      return;
    }
    e.stopPropagation();

    // Custom Select mode: click is selection only, never drag
    if (isCustomSelectMode) {
      return;
    }

    // Shift + Left Click: selection only, never drag
    if (e.shiftKey) {
      return;
    }

    flushPendingTextEditHistory();
    dragStartSnapshotRef.current = cloneMindMapState(treeData, collapsedNodeIds);
    setActiveNode(node);

    // Check if dragging as part of a multi-selected group
    const currentSelectedIds = selectedNodeIdsRef.current || selectedNodeIds;
    const isNodeInMultiSelection = currentSelectedIds.has(node.id) && currentSelectedIds.size > 1;
    let groupSnapshot = null;
    if (isNodeInMultiSelection) {
      groupSnapshot = {};
      allNodes.forEach(n => {
        if (currentSelectedIds.has(n.id)) {
          groupSnapshot[n.id] = { x: n.x ?? 650, y: n.y ?? 260 };
        }
      });
    }

    // Stable World Coordinate conversion at drag start
    const canvasEl = canvasRef.current;
    const rect = canvasEl ? canvasEl.getBoundingClientRect() : { left: 0, top: 0 };
    const pad = workspacePaddingRef.current;
    const currentScrollLeft = canvasEl ? canvasEl.scrollLeft : 0;
    const currentScrollTop = canvasEl ? canvasEl.scrollTop : 0;

    const startWorldMouseX = (currentScrollLeft + (e.clientX - rect.left)) / zoomLevel - pad.left;
    const startWorldMouseY = (currentScrollTop + (e.clientY - rect.top)) / zoomLevel - pad.top;

    activeDragNodeRef.current = {
      nodeId: node.id,
      startX: typeof node.x === 'number' ? node.x : 650,
      startY: typeof node.y === 'number' ? node.y : 260,
      startWorldMouseX,
      startWorldMouseY,
      isGroupDrag: isNodeInMultiSelection,
      selectedNodeIdsSnapshot: isNodeInMultiSelection ? new Set(currentSelectedIds) : null,
      groupSnapshot,
      hasMoved: false,
      latestDx: 0,
      latestDy: 0
    };

    setDraggingNodeId(node.id);
    setLiveDragOffset({ dx: 0, dy: 0 });
  }, [treeData, collapsedNodeIds, allNodes, selectedNodeIds, isCustomSelectMode, zoomLevel, flushPendingTextEditHistory]);

  // Global mousemove & mouseup listeners for real-time smooth node dragging and marquee box selection
  useEffect(() => {
    const handleGlobalMouseMove = (e) => {
      // Marquee Box Selection during Shift+drag or Custom mode drag
      if (isBoxSelectingRef.current) {
        const startX = boxSelectStartRef.current.x;
        const startY = boxSelectStartRef.current.y;
        const currentX = e.clientX;
        const currentY = e.clientY;

        setSelectionBox({
          startX,
          startY,
          currentX,
          currentY
        });

        const boxLeft = Math.min(startX, currentX);
        const boxRight = Math.max(startX, currentX);
        const boxTop = Math.min(startY, currentY);
        const boxBottom = Math.max(startY, currentY);

        const nodesToCheck = allNodesRef.current || [];
        const newlySelected = new Set();
        nodesToCheck.forEach(node => {
          if (!isLeafNode(node)) return;
          const nodeEl = document.getElementById(`node-${node.id}`);
          if (nodeEl) {
            const rect = nodeEl.getBoundingClientRect();
            const intersects = !(
              rect.right < boxLeft ||
              rect.left > boxRight ||
              rect.bottom < boxTop ||
              rect.top > boxBottom
            );
            if (intersects) {
              newlySelected.add(node.id);
            }
          }
        });

        selectedNodeIdsRef.current = newlySelected;
        setSelectedNodeIds(newlySelected);
        return;
      }

      if (!activeDragNodeRef.current) return;
      const { startWorldMouseX, startWorldMouseY } = activeDragNodeRef.current;

      const canvasEl = canvasRef.current;
      if (!canvasEl) return;
      const rect = canvasEl.getBoundingClientRect();
      const pad = workspacePaddingRef.current;

      // Smooth viewport auto-scroll when dragging near viewport boundaries
      // Disabled in Read Mode to prevent glitching when dragging near Floating Media Window
      if (!isReadMode) {
        const scrollMargin = 50;
        const scrollSpeed = 12;

        if (e.clientX > rect.right - scrollMargin) {
          canvasEl.scrollLeft += scrollSpeed;
        } else if (e.clientX < rect.left + scrollMargin && canvasEl.scrollLeft > 0) {
          canvasEl.scrollLeft = Math.max(0, canvasEl.scrollLeft - scrollSpeed);
        }

        if (e.clientY > rect.bottom - scrollMargin) {
          canvasEl.scrollTop += scrollSpeed;
        } else if (e.clientY < rect.top + scrollMargin && canvasEl.scrollTop > 0) {
          canvasEl.scrollTop = Math.max(0, canvasEl.scrollTop - scrollSpeed);
        }
      }

      // Convert current viewport mouse position directly to single world coordinate system
      const currentWorldMouseX = (canvasEl.scrollLeft + (e.clientX - rect.left)) / zoomLevel - pad.left;
      const currentWorldMouseY = (canvasEl.scrollTop + (e.clientY - rect.top)) / zoomLevel - pad.top;

      const deltaX = Math.round(currentWorldMouseX - startWorldMouseX);
      const deltaY = Math.round(currentWorldMouseY - startWorldMouseY);

      activeDragNodeRef.current.latestDx = deltaX;
      activeDragNodeRef.current.latestDy = deltaY;

      if (!activeDragNodeRef.current.hasMoved && Math.hypot(deltaX, deltaY) > 2) {
        activeDragNodeRef.current.hasMoved = true;
      }

      // Throttle visual update using requestAnimationFrame to eliminate full-tree re-renders on mousemove
      if (!dragRafIdRef.current) {
        dragRafIdRef.current = requestAnimationFrame(() => {
          dragRafIdRef.current = null;
          if (activeDragNodeRef.current) {
            setLiveDragOffset({
              dx: activeDragNodeRef.current.latestDx,
              dy: activeDragNodeRef.current.latestDy
            });
          }
        });
      }
    };

    const handleGlobalMouseUp = () => {
      if (dragRafIdRef.current) {
        cancelAnimationFrame(dragRafIdRef.current);
        dragRafIdRef.current = null;
      }

      if (isBoxSelectingRef.current) {
        isBoxSelectingRef.current = false;
        setSelectionBox(null);
        if (selectedNodeIdsRef.current && selectedNodeIdsRef.current.size > 0) {
          const firstId = Array.from(selectedNodeIdsRef.current)[0];
          const n = findNodeById(treeDataRef.current, firstId);
          if (n) {
            setActiveNode(n);
          }
        }
        setIsCustomSelectMode(false);
      }

      if (activeDragNodeRef.current) {
        const { 
          nodeId, 
          hasMoved, 
          isGroupDrag, 
          groupSnapshot, 
          startX, 
          startY, 
          latestDx, 
          latestDy 
        } = activeDragNodeRef.current;

        if (!hasMoved) {
          // Node was clicked without moving; selection is handled by handleNodeClick without forcing inspector open
        } else {
          dragJustFinishedRef.current = true;
          setTimeout(() => {
            dragJustFinishedRef.current = false;
          }, 60);

          if (dragStartSnapshotRef.current) {
            pushSnapshotToUndo(dragStartSnapshotRef.current);
            dragStartSnapshotRef.current = null;
          }
          setHasUnsavedChanges(true);

          // Commit final node positions to treeData exactly ONCE at drag completion
          if (isGroupDrag && groupSnapshot) {
            setTreeData(prev => updateMultipleNodePositionsInTree(prev, groupSnapshot, latestDx, latestDy));
          } else {
            const finalX = startX + latestDx;
            const finalY = startY + latestDy;
            setTreeData(prev => updateNodePositionInTree(prev, nodeId, finalX, finalY));
            setActiveNode(prev => (prev && prev.id === nodeId ? { ...prev, x: finalX, y: finalY } : prev));
          }
        }

        activeDragNodeRef.current = null;
        setDraggingNodeId(null);
        setLiveDragOffset({ dx: 0, dy: 0 });

        // Defer workspace bounds check until node drag has cleanly ended
        if (allNodesRef.current && allNodesRef.current.length > 0) {
          expandWorkspaceForBounds(allNodesRef.current, dimensionsMap);
        }
      }
    };

    window.addEventListener('mousemove', handleGlobalMouseMove);
    window.addEventListener('mouseup', handleGlobalMouseUp);

    return () => {
      if (dragRafIdRef.current) {
        cancelAnimationFrame(dragRafIdRef.current);
        dragRafIdRef.current = null;
      }
      window.removeEventListener('mousemove', handleGlobalMouseMove);
      window.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [zoomLevel, dimensionsMap, expandWorkspaceForBounds, pushSnapshotToUndo, isReadMode]);

  // Change zoom level while preserving the viewport center (or cursor anchor) in world coordinates
  // Change zoom level while keeping the node structure in place (scaling without moving the structure or canvas)
  const changeZoom = useCallback((computeNewZoom) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Use pending target zoom & scroll if a zoom transition is already in flight (e.g. rapid clicks / wheel)
    const effectiveOldZoom = pendingZoomScrollRef.current
      ? pendingZoomScrollRef.current.zoom
      : (zoomLevelRef.current || 1);

    const rawNewZoom = typeof computeNewZoom === 'function' ? computeNewZoom(effectiveOldZoom) : computeNewZoom;
    const newZoom = Math.max(0.35, Math.min(2.5, +(rawNewZoom).toFixed(3)));
    if (newZoom === effectiveOldZoom) return;

    const viewportWidth = canvas.clientWidth;
    const viewportHeight = canvas.clientHeight;

    const currentScrollLeft = pendingZoomScrollRef.current
      ? pendingZoomScrollRef.current.scrollLeft
      : canvas.scrollLeft;
    const currentScrollTop = pendingZoomScrollRef.current
      ? pendingZoomScrollRef.current.scrollTop
      : canvas.scrollTop;

    // Set the anchor to the center of the viewport
    let anchorX = viewportWidth / 2;
    let anchorY = viewportHeight / 2;
    
    // World coordinates of the viewport center
    let unscaledAnchorX = (currentScrollLeft + anchorX) / effectiveOldZoom;
    let unscaledAnchorY = (currentScrollTop + anchorY) / effectiveOldZoom;

    // Target scroll position under the new zoom level such that the viewport center stays at the EXACT same world coordinate
    const targetScrollLeft = unscaledAnchorX * newZoom - anchorX;
    const targetScrollTop = unscaledAnchorY * newZoom - anchorY;

    // Store target scroll position for useLayoutEffect once React commits DOM resize
    pendingZoomScrollRef.current = {
      scrollLeft: targetScrollLeft,
      scrollTop: targetScrollTop,
      zoom: newZoom
    };

    zoomLevelRef.current = newZoom;
    setZoomLevel(newZoom);
  }, []);

  // Fixed zoom in / zoom out handlers (0.35x - 2.5x)
  const handleZoomIn = useCallback(() => {
    changeZoom(prev => Math.min(2.5, +(prev * 1.15).toFixed(3)));
  }, [changeZoom]);

  const handleZoomOut = useCallback(() => {
    changeZoom(prev => Math.max(0.35, +(prev * 0.85).toFixed(3)));
  }, [changeZoom]);

  // Re-center / Focus Viewport on Main Root Node (~180-200px from left edge, vertically centered)
  const handleRecenterStructure = useCallback(() => {
    const el = canvasRef.current;
    if (!el || !treeData) return;

    // Cancel any pending zoom scroll
    pendingZoomScrollRef.current = null;

    const root = treeData;
    const rootX = typeof root.x === 'number' ? root.x : 650;
    const rootY = typeof root.y === 'number' ? root.y : 260;
    const rootDim = dimensionsMapRef.current?.[root.id] || { w: 180, h: 48 };
    const rootNodeHeight = rootDim.h || 48;

    const pad = workspacePaddingRef.current || BASE_WORKSPACE_PADDING;
    const currentZoom = zoomLevelRef.current || 1;
    const desiredRootViewportX = 190; // ~5 cm from left edge of visible canvas area

    const targetScrollLeft = (pad.left + rootX) * currentZoom - desiredRootViewportX;
    const targetScrollTop = (pad.top + rootY + rootNodeHeight / 2) * currentZoom - (el.clientHeight / 2);

    const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);

    const clampedScrollLeft = Math.max(0, Math.min(maxScrollLeft, Math.round(targetScrollLeft)));
    const clampedScrollTop = Math.max(0, Math.min(maxScrollTop, Math.round(targetScrollTop)));

    el.scrollTo({
      left: clampedScrollLeft,
      top: clampedScrollTop,
      behavior: 'smooth'
    });

    canvasViewStateRef.current = {
      scrollLeft: clampedScrollLeft,
      scrollTop: clampedScrollTop
    };
  }, [treeData]);

  // Handle Mouse Scroll Up / Down for node structure zooming
  useEffect(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl || view !== 'flow') return;

    const handleCanvasWheel = (e) => {
      // Allow scrolling inside notes editor, media preview window, inspector sidebar, dropdowns, etc.
      if (e.target.closest('textarea, [contenteditable="true"], .floating-media-window, aside, .import-hub, .rich-text-content, .format-menu-container, .select-menu-container')) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();

      // Mouse Scroll Up → Zoom In; Mouse Scroll Down → Zoom Out (scales in place without moving structure or canvas)
      if (e.deltaY < 0) {
        handleZoomIn();
      } else if (e.deltaY > 0) {
        handleZoomOut();
      }
    };

    // Prevent middle-click scroll icon / autoscroll mode
    const handleAuxClick = (e) => {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    canvasEl.addEventListener('wheel', handleCanvasWheel, { passive: false });
    canvasEl.addEventListener('auxclick', handleAuxClick);
    return () => {
      canvasEl.removeEventListener('wheel', handleCanvasWheel);
      canvasEl.removeEventListener('auxclick', handleAuxClick);
    };
  }, [view, handleZoomIn, handleZoomOut]);

  const connectorPaths = useMemo(() => {
    if (!treeData || allConnections.length === 0) return [];
    const nodeMap = {};
    const isDragActive = !!draggingNodeId;
    const isGroupDrag = isDragActive && selectedNodeIds.size > 1;
    const dx = liveDragOffset.dx;
    const dy = liveDragOffset.dy;

    allNodes.forEach(n => {
      if (!n || !n.id) return;
      const isMoved = isDragActive && ((isGroupDrag && selectedNodeIds.has(n.id)) || (n.id === draggingNodeId));
      if (isMoved) {
        nodeMap[n.id] = {
          ...n,
          x: (n.x ?? 650) + dx,
          y: (n.y ?? 260) + dy
        };
      } else {
        nodeMap[n.id] = n;
      }
    });

    return allConnections.map(conn => {
      const fromNode = (conn.from && nodeMap[conn.from.id]) || conn.from;
      const toNode = (conn.to && nodeMap[conn.to.id]) || conn.to;
      if (!fromNode || !toNode) return null;
      const pathData = calculateConnectorPath(fromNode, toNode, dimensionsMap, conn.branchType);
      return {
        id: conn.id,
        ...pathData
      };
    }).filter(Boolean);
  }, [treeData, allNodes, allConnections, dimensionsMap, liveDragOffset, draggingNodeId, selectedNodeIds]);

  const toggleReadMode = useCallback(() => {
    setIsReadMode(prev => {
      const next = !prev;
      if (next) {
        setIsSidebarOpen(true);
        if (!activeNode && treeData) setActiveNode(treeData);
        setIsFloatingMediaOpen(true);
      }
      return next;
    });
  }, [activeNode, treeData, setIsSidebarOpen, setActiveNode, setIsFloatingMediaOpen]);

  // Center canvas viewport on entering flow view inside the padded workspace
  useEffect(() => {
    if (view === 'flow' && canvasRef.current) {
      const el = canvasRef.current;
      const timer = setTimeout(() => {
        if (el) {
          if (canvasViewStateRef.current.scrollLeft !== null && canvasViewStateRef.current.scrollTop !== null) {
            el.scrollLeft = canvasViewStateRef.current.scrollLeft;
            el.scrollTop = canvasViewStateRef.current.scrollTop;
          } else {
            // Initial centered positioning with padded workspace
            const rootX = treeDataRef.current?.x ?? 650;
            const rootY = treeDataRef.current?.y ?? 260;
            const padLeft = workspacePaddingRef.current.left;
            const padTop = workspacePaddingRef.current.top;
            const currentZoom = zoomLevelRef.current || 1;
            const targetScrollLeft = Math.max(0, (padLeft + rootX) * currentZoom - el.clientWidth / 2);
            const targetScrollTop = Math.max(0, (padTop + rootY) * currentZoom - el.clientHeight / 2);
            el.scrollLeft = targetScrollLeft;
            el.scrollTop = targetScrollTop;
            canvasViewStateRef.current = { scrollLeft: targetScrollLeft, scrollTop: targetScrollTop };
          }
        }
      }, 60);
      return () => clearTimeout(timer);
    }
  }, [view]);

  const handleStartThinking = (e) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    if (treeData) {
      pushSnapshotToUndo(cloneMindMapState(treeData, collapsedNodeIds));
    }

    if (inputText.toLowerCase().includes('react')) {
      const initialPreset = ensureNodePositions(reactPresetTree);
      setTreeData(initialPreset);
      setActiveNode(initialPreset);
    } else {
      const newRoot = { 
        id: 'root', 
        text: inputText.trim(), 
        notes: '', 
        drawing: null, 
        images: [],
        x: 650,
        y: 260,
        rightChildren: [],
        children: [] 
      };
      setTreeData(newRoot);
      setActiveNode(newRoot);
    }
    setView('flow');
    setIsSidebarOpen(true);
    setActiveSection('inspector');
    setHasUnsavedChanges(true);
  };

  const handleCreateNodeInDirection = (targetNode, direction, customText = '') => {
    if (!targetNode || !treeData) return;
    flushPendingTextEditHistory();
    const targetDir = direction || activeCreationDirection || 'bottom';
    setActiveCreationDirection(targetDir);

    const { updatedTree, newNode } = addNodeInDirection(treeData, targetNode.id, targetDir, customText);

    if (updatedTree && newNode) {
      pushSnapshotToUndo(cloneMindMapState(treeData, collapsedNodeIds));
      setTreeData(updatedTree);
      // Keep the parent node selected (never switch selection to the newly created child)
      const updatedParent = findNodeById(updatedTree, targetNode.id) || targetNode;
      setActiveNode(updatedParent);
      setHasUnsavedChanges(true);
    }
  };

  const handleAddThought = (e) => {
    e.preventDefault();
    if (!newThoughtText.trim() || !activeNode || !treeData) return;
    
    handleCreateNodeInDirection(activeNode, activeCreationDirection, newThoughtText.trim());
    setNewThoughtText('');
  };

  const handleUpdateNode = useCallback((updates) => {
    if (!activeNode || !treeData) return;

    const isTextOrNotes = updates.text !== undefined || updates.notes !== undefined;
    
    if (isTextOrNotes) {
      // Continuous text editing session: capture snapshot before the first edit in session
      if (!pendingTextEditSnapshotRef.current) {
        pendingTextEditSnapshotRef.current = cloneMindMapState(treeData, collapsedNodeIds);
      }
      if (textEditDebounceTimerRef.current) {
        clearTimeout(textEditDebounceTimerRef.current);
      }
      textEditDebounceTimerRef.current = setTimeout(() => {
        if (pendingTextEditSnapshotRef.current) {
          pushSnapshotToUndo(pendingTextEditSnapshotRef.current);
          pendingTextEditSnapshotRef.current = null;
        }
        textEditDebounceTimerRef.current = null;
      }, 800);
    } else {
      // Discrete action: drawings, sketches, or photos
      if (textEditDebounceTimerRef.current) {
        clearTimeout(textEditDebounceTimerRef.current);
        textEditDebounceTimerRef.current = null;
      }
      if (pendingTextEditSnapshotRef.current) {
        pushSnapshotToUndo(pendingTextEditSnapshotRef.current);
        pendingTextEditSnapshotRef.current = null;
      }
      pushSnapshotToUndo(cloneMindMapState(treeData, collapsedNodeIds));
    }

    const updatedTree = updateNodeInTree(treeData, activeNode.id, updates);
    setTreeData(updatedTree);
    setActiveNode(prev => (prev ? { ...prev, ...updates } : prev));
    setHasUnsavedChanges(true);
  }, [activeNode, treeData, collapsedNodeIds, pushSnapshotToUndo]);

  // Unsaved Changes and Mind Map Import/Export State
  const [showImportWarningModal, setShowImportWarningModal] = useState(false);
  const [showClearWarningModal, setShowClearWarningModal] = useState(false);
  const [importError, setImportError] = useState(null);
  const mindMapFileInputRef = useRef(null);
  // Delete confirmation state for nodes that have children
  const [nodeToDelete, setNodeToDelete] = useState(null);

  const resetFlow = useCallback(() => {
    if (treeData) {
      flushPendingTextEditHistory();
      pushSnapshotToUndo(cloneMindMapState(treeData, collapsedNodeIds));
    }
    setView('welcome');
    setInputText('');
    setTreeData(null);
    setActiveNode(null);
    setNodeToDelete(null);
    setShowImportWarningModal(false);
    setShowClearWarningModal(false);
    setImportError(null);
    setHasUnsavedChanges(false);
    setCollapsedNodeIds(new Set());
    setDimensionsMap({});
    dimensionsMapRef.current = {};
    setIsSidebarOpen(false);
    setActiveSection('importedFiles');
    setZoomLevel(1);
    setPreviewFile(null);
    setThoughtBoxPos(null);
    setIsThoughtBoxCollapsed(false);
    setActiveCreationDirection('bottom');
  }, [treeData, collapsedNodeIds, pushSnapshotToUndo, flushPendingTextEditHistory, setView, setInputText, setTreeData, setActiveNode, setNodeToDelete, setShowImportWarningModal, setShowClearWarningModal, setImportError, setHasUnsavedChanges, setCollapsedNodeIds, setDimensionsMap, setIsSidebarOpen, setZoomLevel, setPreviewFile, setThoughtBoxPos, setIsThoughtBoxCollapsed, setActiveCreationDirection]);

  // Handle Clear button click (checks for unsaved changes)
  const handleClearClick = () => {
    if (hasUnsavedChanges) {
      setShowClearWarningModal(true);
    } else {
      resetFlow();
    }
  };

  const executeDeleteNode = useCallback((nodeId) => {
    if (!nodeId || !treeData || nodeId === treeData.id) return;
    flushPendingTextEditHistory();
    pushSnapshotToUndo(cloneMindMapState(treeData, collapsedNodeIds));
    const updatedTree = deleteNodeFromTree(treeData, nodeId);
    setTreeData(updatedTree);
    if (activeNode?.id === nodeId) {
      setActiveNode(updatedTree);
    }
    setHasUnsavedChanges(true);
    setNodeToDelete(null);
  }, [treeData, collapsedNodeIds, activeNode, pushSnapshotToUndo, flushPendingTextEditHistory, setTreeData, setActiveNode, setHasUnsavedChanges, setNodeToDelete]);

  const handleDeleteNode = useCallback((nodeId) => {
    if (isReadMode) return;
    if (!nodeId || !treeData || nodeId === treeData.id) return;
    executeDeleteNode(nodeId);
  }, [isReadMode, treeData, executeDeleteNode]);

  const handleNodeClick = (node, e) => {
    if (!node) return;
    if (dragJustFinishedRef.current) {
      return;
    }
    flushPendingTextEditHistory();

    const isLeaf = isLeafNode(node);

    if (isCustomSelectMode) {
      if (!isLeaf) {
        // Parent nodes with children are skipped in custom multi-select mode
        return;
      }
      setSelectedNodeIds(prev => {
        const next = new Set(prev);
        if (next.has(node.id)) {
          next.delete(node.id);
        } else {
          next.add(node.id);
        }
        selectedNodeIdsRef.current = next;
        return next;
      });
      setActiveNode(node);
      setIsCustomSelectMode(false);
      return;
    }

    if (e && e.shiftKey) {
      if (!isLeaf) {
        // Parent nodes with children cannot enter multi-selection
        return;
      }
      setSelectedNodeIds(prev => {
        const next = new Set(prev);
        if (next.has(node.id)) {
          next.delete(node.id);
        } else {
          next.add(node.id);
        }
        selectedNodeIdsRef.current = next;
        return next;
      });
      setActiveNode(node);
      return;
    }

    // Normal click without shift: clear multi-selection and select single node
    const emptySet = new Set();
    selectedNodeIdsRef.current = emptySet;
    setSelectedNodeIds(emptySet);
    setActiveNode(node);
    if (isSidebarOpen) {
      setActiveSection('inspector');
    }
  };

  const handleOpenMediaTab = (node, tabType) => {
    setActiveNode(node);
    setActiveSection('inspector');
    if (!isSidebarOpen) setIsSidebarOpen(true);

    if (isReadMode) {
      setIsFloatingMediaOpen(true);
    } else {
      setSidebarTab(tabType === 'photos' ? 'photos' : 'notes');
    }
  };

  // Dedicated Mind Map JSON Export (Strictly excludes Preview files & metadata)
  const exportMap = () => {
    if (!treeData) return;
    const exportData = {
      format: "thoughtflow",
      version: 1,
      type: "mindmap",
      tree: treeData
    };
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportData, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `${treeData.text || 'thoughtflow'}-mindmap.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    setHasUnsavedChanges(false);
  };

  // Mind Map Import Trigger (Checks for unsaved changes)
  const handleImportClick = () => {
    if (hasUnsavedChanges) {
      setShowImportWarningModal(true);
    } else {
      mindMapFileInputRef.current?.click();
    }
  };

  const handleConfirmImportWarning = () => {
    setShowImportWarningModal(false);
    mindMapFileInputRef.current?.click();
  };

  // Dedicated Mind Map JSON Importer (Separated completely from processImportFiles)
  const openMindMapFromFile = useCallback(async (file) => {
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      
      let incomingTree = null;
      if (parsed && typeof parsed === 'object') {
        if (parsed.format === 'thoughtflow' && parsed.tree && typeof parsed.tree === 'object') {
          incomingTree = parsed.tree;
        } else if (parsed.id && (parsed.text !== undefined || parsed.children || parsed.rightChildren)) {
          // Backward compatibility for raw treeData JSON
          incomingTree = parsed;
        }
      }

      if (!incomingTree || !incomingTree.id) {
        setImportError("Invalid ThoughtFlow note file.");
        if (mindMapFileInputRef.current) mindMapFileInputRef.current.value = '';
        return;
      }

      if (treeData) {
        pushSnapshotToUndo(cloneMindMapState(treeData, collapsedNodeIds));
      }
      const positionedTree = ensureNodePositions(incomingTree);
      setTreeData(positionedTree);
      setActiveNode(positionedTree);
      setView('flow');
      setIsSidebarOpen(true);
      setActiveSection('inspector');
      setPreviewFile(null);
      setImportedFiles([]);
      setCollapsedNodeIds(new Set());
      setHasUnsavedChanges(false);
      setImportError(null);

      // Reset cached canvas scroll position from previous mind map
      canvasViewStateRef.current = { scrollLeft: null, scrollTop: null };

      // Center canvas viewport on the imported root node
      const rootX = positionedTree?.x ?? 650;
      const rootY = positionedTree?.y ?? 260;

      setTimeout(() => {
        const el = canvasRef.current;
        if (el) {
          const padLeft = workspacePaddingRef.current.left;
          const padTop = workspacePaddingRef.current.top;
          const currentZoom = zoomLevelRef.current || 1;
          const targetScrollLeft = Math.max(0, (padLeft + rootX) * currentZoom - el.clientWidth / 2);
          const targetScrollTop = Math.max(0, (padTop + rootY) * currentZoom - el.clientHeight / 2);
          el.scrollLeft = targetScrollLeft;
          el.scrollTop = targetScrollTop;
          canvasViewStateRef.current = { scrollLeft: targetScrollLeft, scrollTop: targetScrollTop };
        }
      }, 50);
    } catch (err) {
      console.error('Failed to open ThoughtFlow note:', err);
      setImportError("Invalid ThoughtFlow note file.");
    } finally {
      if (mindMapFileInputRef.current) {
        mindMapFileInputRef.current.value = '';
      }
    }
  }, [treeData, collapsedNodeIds, pushSnapshotToUndo, setImportError, setTreeData, setActiveNode, setView, setIsSidebarOpen, setPreviewFile, setImportedFiles, setCollapsedNodeIds, setHasUnsavedChanges]);

  const handleImportMindMap = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await openMindMapFromFile(file);
  };

  // Global Drag & Drop State with Live Context-Aware Target Zone ('photos' | 'preview' | 'imported')
  const [isGlobalDraggingFile, setIsGlobalDraggingFile] = useState(false);
  const [dragTargetZone, setDragTargetZone] = useState('imported');
  const dragCounterRef = useRef(0);

  // Process and import files (used by both Browse button & Global Drag-and-Drop)
  const processImportFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    setIsUploading(true);
    const newProcessedFiles = [];

    for (const file of files) {
      let fileType = 'text';
      if (file.type.startsWith('image/')) {
        fileType = 'image';
      } else if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        fileType = 'pdf';
      }

      const fileObj = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
        name: file.name,
        sizeFormatted: formatFileSize(file.size),
        type: fileType,
        url: URL.createObjectURL(file),
        textContent: '',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };

      if (fileType === 'text') {
        try {
          fileObj.textContent = await file.text();
        } catch {
          fileObj.textContent = 'Could not read text file content.';
        }
      }

      newProcessedFiles.push(fileObj);
    }

    setImportedFiles(prev => [...newProcessedFiles, ...prev]);
    setIsUploading(false);
    setIsFolderMenuOpen(true);
    
    // Always auto-preview the newly uploaded / pasted file immediately
    if (newProcessedFiles.length > 0) {
      setPreviewFile(newProcessedFiles[0]);
    }

    // Reset input value to allow re-uploading the same file
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [setIsUploading, setImportedFiles, setIsFolderMenuOpen, setPreviewFile]);

  // Top-Left Import Hub Paste handler (reuses readClipboardAsFiles)
  const handleHubPasteClipboard = async () => {
    try {
      const files = await readClipboardAsFiles();
      if (files && files.length > 0) {
        setActiveSection('preview');
        await processImportFiles(files);
      } else {
        alert('Clipboard is empty. Copy some text or capture a screenshot (Win+Shift+S or PrtScn) and press Ctrl+V to paste!');
      }
    } catch {
      alert('Press Ctrl+V anywhere on the screen to paste text or screenshots directly!');
    }
  };

  // Process and attach image files directly to active node
  const processNodeImages = useCallback(async (files, targetNode = activeNode) => {
    if (!targetNode || !treeData || !files || files.length === 0) return;
    const newImageObjects = [];
    
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      const dataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.readAsDataURL(file);
      });

      newImageObjects.push({
        id: `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: file.name || `Photo_${new Date().toISOString().slice(0, 10)}.png`,
        url: dataUrl,
        size: file.size,
        sizeFormatted: formatFileSize(file.size),
        date: new Date().toLocaleDateString()
      });
    }

    if (newImageObjects.length > 0) {
      const existingImages = targetNode.images || [];
      const updatedImages = [...existingImages, ...newImageObjects];
      handleUpdateNode({ images: updatedImages });
      setSidebarTab('photos');
      setActiveSection('inspector');
      setIsSidebarOpen(true);
      setHasUnsavedChanges(true);
    }
  }, [activeNode, treeData, handleUpdateNode, setSidebarTab, setActiveSection, setIsSidebarOpen, setHasUnsavedChanges]);

  // Global Drag & Drop Everywhere on the Website (Context-Aware)
  useEffect(() => {
    const handleDragEnter = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files')) {
        dragCounterRef.current += 1;
        if (dragCounterRef.current === 1) {
          setIsGlobalDraggingFile(true);
        }
      }
    };

    const handleDragOver = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }

      // Check if hovering over Node Inspector aside or floating media window
      const asideElement = document.querySelector('aside');
      const floatingElement = document.querySelector('.floating-media-window');
      const isOverInspector = isSidebarOpen && (
        (asideElement && asideElement.contains(e.target)) || 
        (e.clientX >= window.innerWidth - (sidebarWidth || 384))
      );
      const isOverFloating = floatingElement && floatingElement.contains(e.target);

      // Check if hovering over preview modal
      const previewModalElement = document.querySelector('.file-preview-modal');
      const isOverPreview = previewFile && (
        (previewModalElement && previewModalElement.contains(e.target)) ||
        (e.clientX <= 48 + (previewWidth || 480) && e.clientY >= 80 && e.clientY <= window.innerHeight - 20)
      );

      if ((isOverInspector || isOverFloating) && activeNode) {
        setDragTargetZone('photos');
      } else if (isOverPreview) {
        setDragTargetZone('preview');
      } else {
        setDragTargetZone('imported');
      }
    };

    const handleDragLeave = (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) {
        setIsGlobalDraggingFile(false);
        setDragTargetZone('imported');
      }
    };

    const handleDragEnd = () => {
      dragCounterRef.current = 0;
      setIsGlobalDraggingFile(false);
      setDragTargetZone('imported');
    };

    const handleDrop = async (e) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsGlobalDraggingFile(false);
      setDragTargetZone('imported');

      if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;

      // On Welcome page, drag-and-drop strictly opens an exported ThoughtFlow note
      if (view === 'welcome') {
        const firstFile = e.dataTransfer.files[0];
        if (firstFile) {
          await openMindMapFromFile(firstFile);
        }
        return;
      }

      // In Flow view, perform context-aware routing (Node Photos vs Preview / Imported Files)
      const asideElement = document.querySelector('aside');
      const floatingElement = document.querySelector('.floating-media-window');
      const isOverInspector = isSidebarOpen && (
        (asideElement && asideElement.contains(e.target)) || 
        (e.clientX >= window.innerWidth - (sidebarWidth || 384))
      );
      const isOverFloating = floatingElement && floatingElement.contains(e.target);

      if ((isOverInspector || isOverFloating) && activeNode) {
        // Routes to active node photos
        await processNodeImages(e.dataTransfer.files, activeNode);
      } else if (!isReadMode) {
        // Routes to general Imported Files & Preview Window (only if not in Read Mode)
        setActiveSection('preview');
        await processImportFiles(e.dataTransfer.files);
      }
    };

    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('dragend', handleDragEnd);
    window.addEventListener('drop', handleDrop);

    return () => {
      window.removeEventListener('dragenter', handleDragEnter);
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('dragend', handleDragEnd);
      window.removeEventListener('drop', handleDrop);
    };
  }, [view, activeNode, isSidebarOpen, sidebarWidth, isReadMode, processNodeImages, openMindMapFromFile, previewFile, previewWidth, processImportFiles]);

  // Global Clipboard Paste Handler (Ctrl+V / Cmd+V for screenshots, copied images, files)
  useEffect(() => {
    const handlePaste = async (e) => {
      const activeEl = document.activeElement;
      const isInput = activeEl && (
        activeEl.tagName === 'INPUT' || 
        activeEl.tagName === 'TEXTAREA' || 
        activeEl.isContentEditable
      );
      if (isInput) return;

      const clipboardData = e.clipboardData || window.clipboardData;
      if (!clipboardData) return;

      const items = Array.from(clipboardData.items || []);
      const files = Array.from(clipboardData.files || []);

      const imageFiles = [];

      // If user pasted image files or items (screenshots)
      if (files.length > 0) {
        for (const file of files) {
          if (file.type.startsWith('image/')) {
            imageFiles.push(file);
          }
        }
      } else {
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            const blob = item.getAsFile();
            if (blob) {
              const ext = item.type.split('/')[1] || 'png';
              const file = new File(
                [blob], 
                `Screenshot_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${ext}`, 
                { type: item.type }
              );
              imageFiles.push(file);
            }
          }
        }
      }

      // If in Read Mode or Node Inspector is active, attach screenshot directly to active node photos!
      if ((isReadMode || effectiveActiveSection === 'inspector') && activeNode && imageFiles.length > 0) {
        e.preventDefault();
        await processNodeImages(imageFiles, activeNode);
        return;
      }

      if (isReadMode) {
        // In read mode, general file import paste is disabled
        return;
      }

      // Otherwise route to workspace Imported Files & Preview Window
      const filesToImport = [...imageFiles];
      if (filesToImport.length === 0) {
        const text = clipboardData.getData('text');
        if (text && text.trim()) {
          const cleanText = text.trim();
          const firstLine = cleanText.split('\n')[0].replace(/[^\w\s-]/gi, '').trim().slice(0, 24);
          const title = firstLine.length > 2 ? `${firstLine}.txt` : `Pasted_Note_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`;
          const blob = new Blob([cleanText], { type: 'text/plain;charset=utf-8' });
          const textFile = new File([blob], title, { type: 'text/plain' });
          filesToImport.push(textFile);
        }
      }

      if (filesToImport.length > 0) {
        e.preventDefault();
        setActiveSection('preview');
        await processImportFiles(filesToImport);
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => {
      window.removeEventListener('paste', handlePaste);
    };
  }, [effectiveActiveSection, activeNode, isReadMode, processNodeImages, processImportFiles]);

  // Global Keyboard Shortcuts:
  //   Ctrl+Z       → Undo Mind-Map action
  //   Ctrl+Y / Ctrl+Shift+Z → Redo Mind-Map action
  //   Ctrl+Shift+X → toggle preview (disabled in Read Mode)
  //   Ctrl+Alt+Z   → reset Node Inspector size | Ctrl+Alt+X → toggle Node Inspector
  //   Ctrl+Alt+R   → toggle Read Mode
  useEffect(() => {
    const handleShortcuts = (e) => {
      if (e.key === 'Escape') {
        if (showClearWarningModal) {
          setShowClearWarningModal(false);
          return;
        }
        if (showImportWarningModal) {
          setShowImportWarningModal(false);
          return;
        }
        if (nodeToDelete) {
          setNodeToDelete(null);
          return;
        }
        if (importError) {
          setImportError(null);
          return;
        }
      }

      // Skip when typing in an input / textarea / contenteditable so native text editing / delete works
      const activeEl = document.activeElement;
      const isTyping = activeEl && (
        activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'TEXTAREA' ||
        activeEl.isContentEditable ||
        activeEl.closest('.rich-text-content[contenteditable="true"]') ||
        activeEl.closest('[contenteditable="true"]') ||
        activeEl.closest('input, textarea')
      );
      if (isTyping) return;

      // Keyboard Delete shortcut: delete selected node(s) in Normal Mode only
      if (e.key === 'Delete' || e.code === 'Delete') {
        if (isReadMode) return;
        // Multiple nodes selected via multi-selection
        if (selectedNodeIds && selectedNodeIds.size > 1) {
          e.preventDefault();
          handleBulkDeleteNodes();
          return;
        }
        // Single node selected via multi-selection
        if (selectedNodeIds && selectedNodeIds.size === 1) {
          const singleId = Array.from(selectedNodeIds)[0];
          if (singleId && treeData && singleId !== treeData.id) {
            e.preventDefault();
            handleDeleteNode(singleId);
            setSelectedNodeIds(new Set());
          }
          return;
        }
        // Exactly one node selected/active via activeNode
        if (activeNode && treeData && activeNode.id !== treeData.id) {
          e.preventDefault();
          handleDeleteNode(activeNode.id);
          return;
        }
      }

      const isKeyZ = e.key?.toLowerCase() === 'z' || e.code === 'KeyZ';
      const isKeyY = e.key?.toLowerCase() === 'y' || e.code === 'KeyY';
      const isKeyX = e.key?.toLowerCase() === 'x' || e.code === 'KeyX';
      const isKeyR = e.key?.toLowerCase() === 'r' || e.code === 'KeyR';

      // Alt + + / Alt + = → Zoom In
      // Alt + - / Alt + _ → Zoom Out
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        if (e.key === '+' || e.key === '=' || e.code === 'Equal' || e.code === 'NumpadAdd') {
          e.preventDefault();
          handleZoomIn();
          return;
        } else if (e.key === '-' || e.key === '_' || e.code === 'Minus' || e.code === 'NumpadSubtract') {
          e.preventDefault();
          handleZoomOut();
          return;
        }
      }

      // Mind-Map History Shortcuts (Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z)
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (e.shiftKey && isKeyZ) {
          // Ctrl + Shift + Z → Redo
          e.preventDefault();
          handleRedo();
          return;
        } else if (!e.shiftKey && isKeyZ) {
          // Ctrl + Z → Undo
          e.preventDefault();
          handleUndo();
          return;
        } else if (isKeyY) {
          // Ctrl + Y → Redo
          e.preventDefault();
          handleRedo();
          return;
        }
      }

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && isKeyX) {
        if (isReadMode) return;
        // Ctrl + Shift + X → Toggle preview window open / closed
        e.preventDefault();
        setPreviewFile(prev => {
          if (prev) return null; // already open → close
          return importedFiles[0] ?? null;
        });
      } else if ((e.ctrlKey || e.metaKey) && e.altKey && isKeyZ) {
        // Ctrl + Alt + Z → Reset Node Inspector (sidebar) to default width
        e.preventDefault();
        setSidebarWidth(384);
      } else if ((e.ctrlKey || e.metaKey) && e.altKey && isKeyX) {
        // Ctrl + Alt + X → Toggle Node Inspector open / closed
        e.preventDefault();
        setIsSidebarOpen(prev => {
          const nextState = !prev;
          if (nextState) {
            setActiveSection('inspector');
            if (!activeNode && treeData) {
              setActiveNode(treeData);
            }
          } else {
            setActiveSection('importedFiles');
          }
          return nextState;
        });
      } else if ((e.ctrlKey || e.metaKey) && e.altKey && isKeyR) {
        // Ctrl + Alt + R → Toggle Read Mode
        e.preventDefault();
        toggleReadMode();
      }
    };
    window.addEventListener('keydown', handleShortcuts);
    return () => window.removeEventListener('keydown', handleShortcuts);
  }, [importedFiles, isSidebarOpen, activeNode, treeData, isReadMode, selectedNodeIds, handleDeleteNode, handleBulkDeleteNodes, handleUndo, handleRedo, toggleReadMode, handleZoomIn, handleZoomOut, showClearWarningModal, showImportWarningModal, nodeToDelete, importError]);




  const handleFileUpload = (e) => {

    if (e.target.files) {
      processImportFiles(e.target.files);
    }
  };

  const handleDeleteImportedFile = (fileId, e) => {
    e?.stopPropagation();
    setImportedFiles(prev => {
      const remaining = prev.filter(f => f.id !== fileId);
      if (previewFile?.id === fileId) {
        if (remaining.length > 0) {
          const currentIdx = prev.findIndex(f => f.id === fileId);
          const nextIdx = Math.min(remaining.length - 1, Math.max(0, currentIdx));
          setPreviewFile(remaining[nextIdx]);
        } else {
          setPreviewFile(null);
        }
      }
      return remaining;
    });
  };



  // Resizable Node Inspector Sidebar (Drags left border, expandable up to half / 50% of the screen without merging)
  const handleSidebarResizeMouseDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsSidebarResizing(true);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';

    const startX = e.clientX;
    const startWidth = sidebarWidth;
    let rafId = null;

    const onMouseMove = (moveEvent) => {
      moveEvent.preventDefault();
      const dx = moveEvent.clientX - startX;
      // Calculate boundary so sidebar never merges or overlaps with the preview window
      const previewRightEdge = previewFile ? (24 + previewWidth + 24) : 0;
      const maxAvailableForSidebar = previewFile 
        ? Math.max(280, window.innerWidth - previewRightEdge)
        : Math.floor(window.innerWidth * 0.5);

      const maxW = Math.min(Math.floor(window.innerWidth * 0.5), maxAvailableForSidebar);
      const minW = 280;
      const newWidth = Math.max(minW, Math.min(maxW, Math.round(startWidth - dx)));

      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        setSidebarWidth(newWidth);
      });
    };

    const onMouseUp = () => {
      setIsSidebarResizing(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove, { passive: false });
    window.addEventListener('mouseup', onMouseUp);
  };

  // Draggable Thought Creation Box Handler
  const handleThoughtBoxDragStart = (e) => {
    if (e.target.closest('input, button, textarea, a, .no-drag')) return;
    e.preventDefault();

    const box = thoughtBoxRef.current || e.currentTarget.closest('.thought-creation-box');
    if (!box) return;
    const rect = box.getBoundingClientRect();

    thoughtBoxDragOffsetRef.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
    isDraggingThoughtBox.current = true;

    // Immediately normalize layout coordinates and apply GPU transform
    box.style.left = '0px';
    box.style.top = '0px';
    box.style.bottom = 'auto';
    box.style.right = 'auto';
    box.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`;
    box.style.transition = 'none';
    box.style.willChange = 'transform';

    let currentX = rect.left;
    let currentY = rect.top;
    thoughtBoxPosRef.current = { x: currentX, y: currentY };

    const onMouseMove = (moveEvent) => {
      if (!isDraggingThoughtBox.current) return;
      
      const maxX = window.innerWidth - rect.width - 10;
      const maxY = window.innerHeight - rect.height - 10;
      currentX = Math.max(10, Math.min(maxX, moveEvent.clientX - thoughtBoxDragOffsetRef.current.x));
      currentY = Math.max(10, Math.min(maxY, moveEvent.clientY - thoughtBoxDragOffsetRef.current.y));
      thoughtBoxPosRef.current = { x: currentX, y: currentY };

      if (!thoughtBoxRafRef.current) {
        thoughtBoxRafRef.current = requestAnimationFrame(() => {
          if (box && isDraggingThoughtBox.current) {
            box.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
          }
          thoughtBoxRafRef.current = null;
        });
      }
    };

    const onMouseUp = () => {
      isDraggingThoughtBox.current = false;
      if (thoughtBoxRafRef.current) {
        cancelAnimationFrame(thoughtBoxRafRef.current);
        thoughtBoxRafRef.current = null;
      }
      if (box) {
        box.style.willChange = 'auto';
        if (thoughtBoxPosRef.current) {
          box.style.transform = `translate3d(${thoughtBoxPosRef.current.x}px, ${thoughtBoxPosRef.current.y}px, 0)`;
        }
      }
      if (thoughtBoxPosRef.current) {
        setThoughtBoxPos(thoughtBoxPosRef.current);
      }
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('mouseup', onMouseUp);
  };

  // Draggable Hexagonal Handle Pointer Events (Handles Click to Toggle vs. Drag to Move)
  const handleHexPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    const box = thoughtBoxRef.current;
    const boxRect = box ? box.getBoundingClientRect() : { 
      left: window.innerWidth / 2 - 280, 
      top: window.innerHeight - 140, 
      width: 560, 
      height: 118 
    };

    let currentX = thoughtBoxPosRef.current ? thoughtBoxPosRef.current.x : boxRect.left;
    let currentY = thoughtBoxPosRef.current ? thoughtBoxPosRef.current.y : boxRect.top;

    if (!thoughtBoxPosRef.current) {
      thoughtBoxPosRef.current = { x: currentX, y: currentY };
      setThoughtBoxPos({ x: currentX, y: currentY });
    }

    const targetBoxWidth = isThoughtBoxCollapsed ? 42 : (box ? box.offsetWidth : Math.min(560, window.innerWidth * 0.92));
    const targetBoxHeight = isThoughtBoxCollapsed ? 36 : (box ? box.offsetHeight : 118);

    hexDragStateRef.current = {
      isDown: true,
      hasMoved: false,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      initialBoxX: currentX,
      initialBoxY: currentY,
      boxWidth: targetBoxWidth,
      boxHeight: targetBoxHeight
    };
    setIsDraggingHex(true);
  };

  const handleHexPointerMove = (e) => {
    if (!hexDragStateRef.current?.isDown) return;
    const { startX, startY, initialBoxX, initialBoxY, boxWidth, boxHeight } = hexDragStateRef.current;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!hexDragStateRef.current.hasMoved && Math.hypot(dx, dy) > 6) {
      hexDragStateRef.current.hasMoved = true;
    }

    if (hexDragStateRef.current.hasMoved) {
      const maxX = Math.max(10, window.innerWidth - boxWidth - 10);
      const maxY = Math.max(10, window.innerHeight - boxHeight - 10);

      const nextX = Math.max(10, Math.min(maxX, initialBoxX + dx));
      const nextY = Math.max(10, Math.min(maxY, initialBoxY + dy));

      thoughtBoxPosRef.current = { x: nextX, y: nextY };

      const box = thoughtBoxRef.current;
      if (box) {
        box.style.transform = `translate3d(${nextX}px, ${nextY}px, 0)`;
      }
    }
  };

  const handleHexPointerUp = (e) => {
    if (!hexDragStateRef.current?.isDown) return;
    const { hasMoved } = hexDragStateRef.current;
    hexDragStateRef.current.isDown = false;
    setIsDraggingHex(false);

    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    if (hasMoved) {
      // Drag action completed: commit final position to state, keep current collapse state
      if (thoughtBoxPosRef.current) {
        setThoughtBoxPos({ ...thoughtBoxPosRef.current });
      }
    } else {
      // Click/Tap action: Toggle open / collapsed with seamless coordinate translation
      const box = thoughtBoxRef.current;
      const boxRect = box ? box.getBoundingClientRect() : null;
      const currentBoxX = thoughtBoxPosRef.current ? thoughtBoxPosRef.current.x : (boxRect ? boxRect.left : window.innerWidth / 2 - 280);
      const currentBoxY = thoughtBoxPosRef.current ? thoughtBoxPosRef.current.y : (boxRect ? boxRect.top : window.innerHeight - 140);

      const targetBoxWidth = Math.min(560, window.innerWidth * 0.92);
      const targetBoxHeight = 118;
      const hexWidth = 42;
      const hexHeight = 36;

      if (!isThoughtBoxCollapsed) {
        // Collapsing: translate position so the standalone hexagon stays exactly at bottom center
        const hexX = currentBoxX + (targetBoxWidth - hexWidth) / 2;
        const hexY = currentBoxY + targetBoxHeight - hexHeight / 2;
        const clampedHexX = Math.max(10, Math.min(window.innerWidth - hexWidth - 10, hexX));
        const clampedHexY = Math.max(10, Math.min(window.innerHeight - hexHeight - 10, hexY));

        thoughtBoxPosRef.current = { x: clampedHexX, y: clampedHexY };
        setThoughtBoxPos({ x: clampedHexX, y: clampedHexY });
        setIsThoughtBoxCollapsed(true);
      } else {
        // Expanding: translate position so the rectangular box expands cleanly above the hexagon
        const hexX = currentBoxX;
        const hexY = currentBoxY;
        let nextBoxX = hexX - (targetBoxWidth - hexWidth) / 2;
        let nextBoxY = hexY - targetBoxHeight + hexHeight / 2;
        nextBoxX = Math.max(10, Math.min(window.innerWidth - targetBoxWidth - 10, nextBoxX));
        nextBoxY = Math.max(10, Math.min(window.innerHeight - targetBoxHeight - 10, nextBoxY));

        thoughtBoxPosRef.current = { x: nextBoxX, y: nextBoxY };
        setThoughtBoxPos({ x: nextBoxX, y: nextBoxY });
        setIsThoughtBoxCollapsed(false);
      }
    }
  };

  // Drag-to-pan implementation or box selection on background canvas
  const handleMouseDown = (e) => {
    // Disable middle mouse scroll button autoscroll
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (activeDragNodeRef.current) return;
    if (e.target.closest('button, input, textarea, a, .rich-text-content, canvas, .import-hub, .thought-creation-box, .mind-map-node, .floating-media-window, aside') || e.target.closest('[style*="aspect-ratio"]')) {
      return;
    }

    // Shift + Left Click Drag OR Custom Mode: Start Box Selection
    if (e.shiftKey || isCustomSelectMode) {
      isBoxSelectingRef.current = true;
      boxSelectStartRef.current = { x: e.clientX, y: e.clientY };
      setSelectionBox({
        startX: e.clientX,
        startY: e.clientY,
        currentX: e.clientX,
        currentY: e.clientY
      });
      return;
    }

    // Normal empty canvas click / drag: clear selection and pan
    if (selectedNodeIds.size > 0) {
      const emptySet = new Set();
      selectedNodeIdsRef.current = emptySet;
      setSelectedNodeIds(emptySet);
    }
    setIsCanvasDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  const handleMouseUp = () => {
    setIsCanvasDragging(false);
  };

  const handleMouseMove = (e) => {
    if (!isCanvasDragging || !canvasRef.current) return;
    const el = canvasRef.current;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;

    el.scrollLeft -= dx;
    el.scrollTop -= dy;
    setDragStart({ x: e.clientX, y: e.clientY });
    canvasViewStateRef.current = {
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop
    };
  };

  if (view === 'welcome') {
    return (
      <div className={`min-h-screen w-full flex flex-col items-center justify-center p-6 font-sans selection:bg-purple-500/30 relative transition-all duration-200 ${
        isGlobalDraggingFile ? 'ring-4 ring-inset ring-purple-500/40' : ''
      }`}
      style={{ backgroundColor: 'var(--tf-bg-app)', color: 'var(--tf-text-primary)' }}>
        
        {/* Theme Toggle - Top Right */}
        <div className="absolute top-6 right-6 z-50">
          <button
            type="button"
            onClick={toggleTheme}
            className={`p-2.5 rounded-xl transition-all duration-300 cursor-pointer flex items-center justify-center border shadow-lg ${
              isDarkMode
                ? 'bg-zinc-900/90 hover:bg-zinc-800 border-zinc-700/80 hover:border-purple-500 text-zinc-300 hover:text-white'
                : 'bg-white border-amber-300 text-amber-500 shadow-amber-200/30 hover:bg-amber-50 hover:shadow-amber-300/40'
            }`}
            title={isDarkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
          >
            {isDarkMode ? (
              <Sun className="w-5 h-5 text-amber-400" />
            ) : (
              <Moon className="w-5 h-5" />
            )}
          </button>
        </div>

        {/* Welcome Page Drag & Drop Subtle Indicator */}
        {isGlobalDraggingFile && (
          <div className="fixed top-6 left-1/2 -translate-x-1/2 z-999999 pointer-events-none animate-in fade-in slide-in-from-top-2 duration-150">
            <div className="px-5 py-2 rounded-full border-2 border-purple-500 shadow-[0_0_30px_rgba(168,85,247,0.45)] backdrop-blur-xl flex items-center space-x-2.5" style={{ backgroundColor: 'var(--tf-bg-surface)', color: 'var(--tf-text-primary)' }}>
              <div className="w-5 h-5 rounded-full bg-purple-500/20 border border-purple-500/40 flex items-center justify-center text-purple-600 dark:text-purple-300">
                <FolderOpen className="w-3 h-3" />
              </div>
              <span className="text-xs font-medium tracking-wide">
                Drop your <strong className="text-purple-600 dark:text-purple-300 font-semibold">ThoughtFlow note here</strong>
              </span>
            </div>
          </div>
        )}

        {/* Hidden File Input specifically for Mind Map JSON Import */}
        <input 
          type="file" 
          ref={mindMapFileInputRef} 
          onChange={handleImportMindMap} 
          accept=".json,application/json" 
          className="hidden" 
        />

        <div className="w-full max-w-2xl mx-auto flex flex-col items-center space-y-10">
          
          <div className="flex items-center space-x-3 px-6 py-2.5 rounded-full border shadow-xl backdrop-blur-md" style={{ backgroundColor: 'var(--tf-bg-surface)', borderColor: 'var(--tf-border)' }}>
            <Brain className="w-5 h-5 text-purple-500 dark:text-purple-400" />
            <span className="font-medium tracking-wide" style={{ color: 'var(--tf-text-primary)' }}>ThoughtFlow Notemaker</span>
          </div>

          <div className="text-center space-y-4">
            <h1 className="text-4xl md:text-6xl font-light tracking-tight" style={{ color: 'var(--tf-text-primary)' }}>
              Visualize Your Thoughts
            </h1>
            <p className="text-lg md:text-xl max-w-lg mx-auto font-light" style={{ color: 'var(--tf-text-secondary)' }}>
              Enter a concept. Expand it with branches, notes, photos, and file previews.
            </p>
          </div>

          <form onSubmit={handleStartThinking} className="w-full relative group">
            <div className="absolute -inset-1 bg-linear-to-r from-purple-600 to-indigo-600 rounded-2xl blur opacity-30 group-hover:opacity-60 transition duration-500"></div>
            <div className="relative flex items-center">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="Try typing 'React' or any concept..."
                className="w-full rounded-2xl px-6 py-5 pl-6 pr-16 focus:outline-none focus:ring-2 focus:ring-purple-500 transition-all text-lg shadow-2xl"
                style={{ backgroundColor: 'var(--tf-bg-elevated)', color: 'var(--tf-text-primary)', borderColor: 'var(--tf-border)', borderStyle: 'solid', borderWidth: '1px' }}
                autoFocus
              />
              <button 
                type="submit"
                disabled={!inputText.trim()}
                className="absolute right-3 p-3 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:hover:bg-purple-600 text-white rounded-xl transition-all cursor-pointer shadow-lg shadow-purple-900/30"
                title="Start Board"
              >
                <ArrowRight className="w-5 h-5" />
              </button>
            </div>
          </form>

          {/* Open Existing Note Button (strictly opens ThoughtFlow Mind Map JSON) */}
          <div className="flex flex-col items-center justify-center pt-2 space-y-2">
            <button
              type="button"
              onClick={() => mindMapFileInputRef.current?.click()}
              className="px-5 py-2.5 rounded-xl transition-all flex items-center space-x-2 shadow-lg cursor-pointer text-sm font-medium hover:scale-[1.02] active:scale-[0.98]"
              style={{ backgroundColor: 'var(--tf-bg-surface)', color: 'var(--tf-connector-anchor)', borderColor: 'var(--tf-border)', borderStyle: 'solid', borderWidth: '1px' }}
              title="Open a previously exported ThoughtFlow note (.json)"
            >
              <FolderOpen className="w-4 h-4" />
              <span>Open Existing Note</span>
            </button>
            <span className="text-xs font-light" style={{ color: 'var(--tf-text-secondary)' }}>
              Open a previously exported ThoughtFlow note
            </span>
          </div>

          <div className="flex items-center text-sm space-x-6" style={{ color: 'var(--tf-text-secondary)' }}>
            <div className="flex items-center space-x-2"><GitBranch className="w-4 h-4 text-purple-500 dark:text-purple-400"/> <span>Branching</span></div>
            <div className="flex items-center space-x-2"><FileText className="w-4 h-4 text-blue-500 dark:text-blue-400"/> <span>Rich Notes</span></div>
            <div className="flex items-center space-x-2"><FileImage className="w-4 h-4 text-purple-500 dark:text-purple-400"/> <span>Photo Attachments</span></div>
          </div>
        </div>

        {/* Invalid Mind Map Error Modal on Welcome Page */}
        {importError && (
          <div 
            className="fixed inset-0 z-999999 flex items-center justify-center bg-black/75 backdrop-blur-sm animate-in fade-in duration-200 select-none p-4"
            onClick={() => setImportError(null)}
          >
            <div 
              className="bg-[#121215] border border-red-500/40 rounded-2xl shadow-[0_25px_70px_rgba(0,0,0,0.85)] max-w-sm w-full p-6 text-zinc-200 animate-in zoom-in-95 duration-200 text-center space-y-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="w-12 h-12 rounded-full bg-red-500/15 border border-red-500/30 text-red-400 flex items-center justify-center mx-auto">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-white">Import Failed</h3>
                <p className="text-sm text-zinc-400 mt-1">{importError}</p>
              </div>
              <button
                type="button"
                onClick={() => setImportError(null)}
                className="w-full py-2 text-sm font-medium bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl transition-colors border border-zinc-700 cursor-pointer"
              >
                OK
              </button>
            </div>
          </div>
        )}

      </div>
    );
  }

  return (
    <div className="h-screen w-full bg-[#09090b] flex flex-col font-sans overflow-hidden selection:bg-purple-500/30 text-zinc-200 relative">
      
      {/* Global Drag & Drop Context-Aware Badge Overlay */}
      {isGlobalDraggingFile && (
        <div className="fixed top-5 left-1/2 -translate-x-1/2 z-999999 pointer-events-none animate-in fade-in slide-in-from-top-2 duration-150">
          <div className="px-5 py-2 rounded-full bg-[#121216]/95 border border-purple-500/80 shadow-[0_0_25px_rgba(168,85,247,0.45)] backdrop-blur-xl flex items-center space-x-2.5 text-white">
            <div className="w-5 h-5 rounded-full bg-purple-500/20 border border-purple-500/40 flex items-center justify-center text-purple-300">
              <Upload className="w-3 h-3" />
            </div>
            <span className="text-xs font-medium tracking-wide">
              {dragTargetZone === 'photos' && (
                <>Drop to <strong className="text-purple-300 font-semibold">Node Photos</strong></>
              )}
              {dragTargetZone === 'preview' && (
                <>Drop to <strong className="text-purple-300 font-semibold">Preview</strong></>
              )}
              {dragTargetZone === 'imported' && (
                <>Drop to <strong className="text-purple-300 font-semibold">Imported Files</strong></>
              )}
            </span>
          </div>
        </div>
      )}

      {/* Hidden File Input for Preview Window */}
      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={handleFileUpload} 
        multiple 
        accept="image/*,application/pdf,.pdf,text/*,.txt,.md,.json,.js,.jsx,.ts,.tsx,.css,.html" 
        className="hidden" 
      />

      {/* Hidden File Input specifically for Mind Map JSON Import */}
      <input 
        type="file" 
        ref={mindMapFileInputRef} 
        onChange={handleImportMindMap} 
        accept=".json,application/json" 
        className="hidden" 
      />

      {/* Clean Header */}
      <header className="flex-none flex items-center justify-between px-6 py-3.5 border-b border-zinc-800/80 bg-[#09090b]/90 backdrop-blur-md z-30">
        
        {/* Top Left: Logo & Read Mode Toggle */}
        <div className="flex items-center space-x-3">
          <div className="bg-purple-500/15 p-2 rounded-xl border border-purple-500/20">
            <Brain className="w-5 h-5 text-purple-400" />
          </div>
          <span className="font-semibold text-white tracking-wide text-lg">ThoughtFlow</span>

          <div className="w-px h-5 bg-zinc-800 hidden sm:block"></div>

          {/* Read Mode Button on Top Left */}
          <button
            type="button"
            onClick={toggleReadMode}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold tracking-wide transition-all duration-300 cursor-pointer flex items-center space-x-2 border shadow-lg ${
              isReadMode
                ? 'bg-linear-to-r from-purple-600 to-indigo-600 border-purple-400 text-white shadow-[0_0_20px_rgba(168,85,247,0.45)] ring-2 ring-purple-400/40'
                : 'bg-zinc-900/90 hover:bg-zinc-800 border-zinc-700/80 hover:border-purple-500 text-zinc-300 hover:text-white'
            }`}
            title={isReadMode ? "Exit Read Mode (Ctrl+Alt+R)" : "Enter Read Mode (Focus notes with floating photos - Ctrl+Alt+R)"}
          >
            <BookOpen className={`w-4 h-4 ${isReadMode ? 'text-white animate-pulse' : 'text-purple-400'}`} />
            <span>Read Mode</span>
            {isReadMode && (
              <span className="px-1.5 py-0.2 rounded-full text-[9px] font-mono bg-emerald-400/25 text-emerald-300 border border-emerald-400/40 ml-0.5">
                ON
              </span>
            )}
          </button>

          {/* Undo / Redo History Buttons on the Right Side of Read Mode */}
          <div className="flex items-center space-x-1 bg-zinc-900/90 p-0.5 rounded-xl border border-zinc-800 shadow-inner">
            <button
              type="button"
              onClick={handleUndo}
              disabled={!canUndo}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 flex items-center space-x-1.5 ${
                canUndo
                  ? 'text-zinc-200 hover:text-white hover:bg-zinc-800 cursor-pointer active:scale-95'
                  : 'text-zinc-600 cursor-not-allowed opacity-40'
              }`}
              title="Undo Mind-Map Action (Ctrl+Z)"
            >
              <Undo2 className={`w-3.5 h-3.5 ${canUndo ? 'text-purple-400' : 'text-zinc-600'}`} />
              <span>Undo</span>
            </button>

            <div className="w-px h-3.5 bg-zinc-800"></div>

            <button
              type="button"
              onClick={handleRedo}
              disabled={!canRedo}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 flex items-center space-x-1.5 ${
                canRedo
                  ? 'text-zinc-200 hover:text-white hover:bg-zinc-800 cursor-pointer active:scale-95'
                  : 'text-zinc-600 cursor-not-allowed opacity-40'
              }`}
              title="Redo Mind-Map Action (Ctrl+Y / Ctrl+Shift+Z)"
            >
              <Redo2 className={`w-3.5 h-3.5 ${canRedo ? 'text-purple-400' : 'text-zinc-600'}`} />
              <span>Redo</span>
            </button>
          </div>

          {/* Light / Dark Mode Toggle */}
          <button
            type="button"
            onClick={toggleTheme}
            className={`px-2.5 py-1.5 rounded-xl text-xs font-semibold tracking-wide transition-all duration-300 cursor-pointer flex items-center space-x-2 border shadow-lg ${
              isDarkMode
                ? 'bg-zinc-900/90 hover:bg-zinc-800 border-zinc-700/80 hover:border-purple-500 text-zinc-300 hover:text-white'
                : 'bg-linear-to-r from-amber-100 to-orange-100 border-amber-300 text-amber-700 shadow-amber-200/30 hover:shadow-amber-300/40'
            }`}
            title={isDarkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
          >
            {isDarkMode ? (
              <Sun className="w-4 h-4 text-amber-400" />
            ) : (
              <Moon className="w-4 h-4 text-indigo-500" />
            )}
            <span>{isDarkMode ? 'Light' : 'Dark'}</span>
          </button>
        </div>
        
        {/* Top Right Controls: Read Mode Path Indicator, Re-center, Zoom Controls, Format, Select, Import & Export */}
        <div className="flex items-center space-x-2">
          {/* Read Mode: Selected Node Path Indicator (positioned immediately to the left of Re-center) */}
          {isReadMode && activeNode && (
            (() => {
              const isRoot = activeNode.id === treeData?.id;
              const selectedName = activeNode.text || 'Untitled';
              const parentNode = !isRoot && treeData ? findParentNode(treeData, activeNode.id) : null;
              const parentName = isRoot ? 'ROOT NODE' : (parentNode?.text || 'ROOT NODE');
              return (
                <div className="flex items-center space-x-2 px-3.5 py-1.5 rounded-xl bg-zinc-900/95 border border-zinc-700 text-xs font-mono max-w-sm md:max-w-lg shadow-md select-none truncate">
                  <span className="text-white font-semibold truncate text-xs sm:text-sm" title={selectedName}>{selectedName}</span>
                  <span className="text-zinc-400 font-medium text-xs px-0.5">from</span>
                  <span className="text-zinc-200 font-medium truncate text-xs sm:text-sm" title={parentName}>{parentName}</span>
                </div>
              );
            })()
          )}

          {/* Re-center / Focus Structure Button */}
          <button 
            type="button"
            onClick={handleRecenterStructure}
            className="text-zinc-300 hover:text-white px-2.5 py-1.5 text-sm font-medium transition-colors flex items-center justify-center bg-zinc-900 hover:bg-zinc-800 rounded-lg border border-zinc-800 hover:border-purple-500/50 cursor-pointer"
            title="Re-center / Focus Structure"
          >
            <LocateFixed className="w-4 h-4 text-purple-400" />
          </button>

          {/* Zoom Out Button */}
          <button 
            type="button"
            onClick={handleZoomOut}
            className="text-zinc-300 hover:text-white px-2.5 py-1.5 text-sm font-medium transition-colors flex items-center justify-center bg-zinc-900 hover:bg-zinc-800 rounded-lg border border-zinc-800 cursor-pointer"
            title="Zoom Out (Scroll Down)"
          >
            <Minus className="w-4 h-4" />
          </button>

          {/* Zoom In Button */}
          <button 
            type="button"
            onClick={handleZoomIn}
            className="text-zinc-300 hover:text-white px-2.5 py-1.5 text-sm font-medium transition-colors flex items-center justify-center bg-zinc-900 hover:bg-zinc-800 rounded-lg border border-zinc-800 cursor-pointer"
            title="Zoom In (Scroll Up)"
          >
            <Plus className="w-4 h-4" />
          </button>

          {/* Format Popover Control */}
          <div className="relative format-menu-container">
            <button 
              type="button"
              onClick={() => {
                if (!hasEnoughChildren) return;
                setIsFormatPopoverOpen(prev => !prev);
              }}
              disabled={!hasEnoughChildren}
              className={`px-3 py-1.5 text-sm font-medium transition-all flex items-center space-x-1.5 rounded-lg border ${
                !hasEnoughChildren
                  ? 'text-zinc-600 bg-zinc-950/60 border-zinc-800/60 cursor-not-allowed opacity-40'
                  : isFormatPopoverOpen
                  ? 'text-purple-300 bg-purple-500/20 border-purple-500/50 shadow-[0_0_15px_rgba(168,85,247,0.35)] ring-1 ring-purple-500/30 cursor-pointer'
                  : 'text-zinc-300 hover:text-white bg-zinc-900 hover:bg-zinc-800 border-zinc-800 hover:border-purple-500/50 cursor-pointer'
              }`}
              title={
                isMultiSelection
                  ? (multiFormatGroups.hasValidGroups
                      ? `Format ${multiFormatGroups.validGroups.length} sibling group${multiFormatGroups.validGroups.length > 1 ? 's' : ''} (${multiFormatGroups.totalValidNodesCount} nodes)`
                      : "Multi-node format requires at least 2 selected sibling nodes in the same direction")
                  : (hasEnoughChildren ? "Format node children layout" : "Format requires a selected node with at least 2 direct children")
              }
            >
              <LayoutGrid className={`w-4 h-4 ${hasEnoughChildren ? 'text-purple-400' : 'text-zinc-600'}`} />
              <span>Format</span>
            </button>

            {/* Format Popover Dropdown */}
            {isFormatPopoverOpen && hasEnoughChildren && (
              <div 
                className="absolute right-0 top-full mt-2 w-64 bg-zinc-900/95 border border-zinc-700/80 backdrop-blur-2xl rounded-2xl p-3.5 shadow-[0_20px_50px_rgba(0,0,0,0.85)] ring-1 ring-purple-500/30 z-50 animate-in fade-in zoom-in-95 duration-150 select-none text-zinc-300 space-y-3"
              >
                {/* Direction Selector */}
                <div>
                  <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-1.5 flex items-center justify-between">
                    <span>Direction</span>
                    <span className="text-[10px] text-purple-400 font-mono">
                      {isMultiSelection
                        ? `${multiFormatGroups.totalValidNodesCount} nodes (${multiFormatGroups.validGroups.length} group${multiFormatGroups.validGroups.length > 1 ? 's' : ''})`
                        : `${childGroups[formatDirection]?.length || 0} nodes`}
                    </span>
                  </div>
                  <div className={`grid grid-cols-2 gap-1.5 bg-zinc-950 p-1 rounded-xl border border-zinc-800 ${isMultiSelection ? 'opacity-40 pointer-events-none' : ''}`}>
                    {(['right', 'down']).map((dir) => {
                      const isIncludedInMulti = isMultiSelection && multiFormatGroups.validGroups.some(g => g.direction === dir);
                      const count = isMultiSelection
                        ? multiFormatGroups.validGroups.filter(g => g.direction === dir).reduce((acc, g) => acc + g.items.length, 0)
                        : (childGroups[dir]?.length || 0);
                      const isEligible = isMultiSelection ? isIncludedInMulti : (count >= 2);
                      const isSelected = isMultiSelection ? isIncludedInMulti : (formatDirection === dir);
                      return (
                        <button
                          key={dir}
                          type="button"
                          disabled={!isEligible || isMultiSelection}
                          onClick={() => setFormatDirection(dir)}
                          className={`py-1.5 rounded-lg text-xs font-medium capitalize transition-all flex items-center justify-center space-x-1.5 ${
                            isSelected
                              ? 'bg-purple-600/90 text-white shadow-md font-semibold cursor-default'
                              : isEligible
                              ? 'text-zinc-300 hover:text-white hover:bg-zinc-800/80 cursor-pointer'
                              : 'text-zinc-600 cursor-not-allowed opacity-30'
                          }`}
                        >
                          <span>{dir}</span>
                          <span className="text-[10px] opacity-70 font-mono">({count})</span>
                        </button>
                      );
                    })}
                  </div>
                  {isMultiSelection && (
                    <div className="mt-1.5 text-[10px] text-purple-400/90 font-mono bg-purple-500/10 border border-purple-500/20 rounded-lg px-2 py-1 flex items-center space-x-1">
                      <span>Auto-formatted by parent & direction</span>
                    </div>
                  )}
                </div>

                {/* Layout Style Selector */}
                <div>
                  <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
                    Layout Style
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 bg-zinc-950 p-1 rounded-xl border border-zinc-800">
                    <button
                      type="button"
                      onClick={() => setFormatLayout('list')}
                      className={`py-1.5 px-3 rounded-lg text-xs font-medium transition-all flex items-center justify-center space-x-1.5 cursor-pointer ${
                        formatLayout === 'list'
                          ? 'bg-purple-600 text-white shadow-md font-semibold'
                          : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/80'
                      }`}
                    >
                      <List className="w-3.5 h-3.5" />
                      <span>List</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setFormatLayout('compact')}
                      className={`py-1.5 px-3 rounded-lg text-xs font-medium transition-all flex items-center justify-center space-x-1.5 cursor-pointer ${
                        formatLayout === 'compact'
                          ? 'bg-purple-600 text-white shadow-md font-semibold'
                          : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/80'
                      }`}
                    >
                      <Layers className="w-3.5 h-3.5" />
                      <span>Compact</span>
                    </button>
                  </div>
                </div>

                {/* Apply Format Button */}
                <button
                  type="button"
                  onClick={() => handleExecuteFormat(formatDirection, formatLayout)}
                  className="w-full py-2 bg-linear-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-medium text-xs rounded-xl shadow-lg shadow-purple-900/30 transition-all flex items-center justify-center space-x-1.5 cursor-pointer active:scale-[0.98]"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Apply Format</span>
                </button>
              </div>
            )}
          </div>

          {/* Select Popover Control */}
          <div className="relative select-menu-container">
            {isCustomSelectMode ? (
              <button 
                type="button"
                onClick={handleCancelCustomMode}
                className="px-3 py-1.5 text-sm font-medium transition-all flex items-center space-x-1.5 rounded-lg border text-red-300 bg-red-500/20 border-red-500/50 shadow-[0_0_15px_rgba(239,68,68,0.35)] ring-1 ring-red-500/30 cursor-pointer"
                title="Exit custom multi-select mode"
              >
                <X className="w-4 h-4 text-red-400" />
                <span>Cancel</span>
              </button>
            ) : (
              <button 
                type="button"
                disabled={!rootHasAnyChildren}
                onClick={() => {
                  if (!rootHasAnyChildren) return;
                  setIsSelectPopoverOpen(prev => !prev);
                }}
                className={`px-3 py-1.5 text-sm font-medium transition-all flex items-center space-x-1.5 rounded-lg border ${
                  !rootHasAnyChildren
                    ? 'text-zinc-600 bg-zinc-950/60 border-zinc-800/60 cursor-not-allowed opacity-40'
                    : isSelectPopoverOpen
                    ? 'text-purple-300 bg-purple-500/20 border-purple-500/50 shadow-[0_0_15px_rgba(168,85,247,0.35)] ring-1 ring-purple-500/30 cursor-pointer'
                    : 'text-zinc-300 hover:text-white bg-zinc-900 hover:bg-zinc-800 border-zinc-800 hover:border-purple-500/50 cursor-pointer'
                }`}
                title={rootHasAnyChildren ? "Multi-select leaf nodes" : "Selection requires direct child branches from the root node"}
              >
                <CheckSquare className={`w-4 h-4 ${rootHasAnyChildren ? 'text-purple-400' : 'text-zinc-600'}`} />
                <span>Select</span>
              </button>
            )}

            {/* Select Popover Dropdown */}
            {isSelectPopoverOpen && !isCustomSelectMode && rootHasAnyChildren && (
              <div 
                className="absolute right-0 top-full mt-2 w-48 bg-zinc-900/95 border border-zinc-700/80 backdrop-blur-2xl rounded-2xl p-2 shadow-[0_20px_50px_rgba(0,0,0,0.85)] ring-1 ring-purple-500/30 z-50 animate-in fade-in zoom-in-95 duration-150 select-none text-zinc-300 space-y-1"
              >
                <button
                  type="button"
                  disabled={!selectionEligibility.hasRight}
                  onClick={handleSelectRight}
                  className={`w-full text-left px-3 py-2 text-xs font-medium rounded-xl flex items-center space-x-2 transition-colors ${
                    selectionEligibility.hasRight
                      ? 'text-zinc-200 hover:text-white hover:bg-purple-600/20 cursor-pointer'
                      : 'text-zinc-600 cursor-not-allowed opacity-35'
                  }`}
                  title={selectionEligibility.hasRight ? "Select all right branch leaf nodes of active node" : "Active node has no right branch children"}
                >
                  <ArrowRight className={`w-3.5 h-3.5 ${selectionEligibility.hasRight ? 'text-purple-400' : 'text-zinc-600'}`} />
                  <span>Select Right</span>
                </button>
                <button
                  type="button"
                  disabled={!selectionEligibility.hasBottom}
                  onClick={handleSelectBottom}
                  className={`w-full text-left px-3 py-2 text-xs font-medium rounded-xl flex items-center space-x-2 transition-colors ${
                    selectionEligibility.hasBottom
                      ? 'text-zinc-200 hover:text-white hover:bg-purple-600/20 cursor-pointer'
                      : 'text-zinc-600 cursor-not-allowed opacity-35'
                  }`}
                  title={selectionEligibility.hasBottom ? "Select all bottom branch leaf nodes of active node" : "Active node has no bottom branch children"}
                >
                  <ChevronDown className={`w-3.5 h-3.5 ${selectionEligibility.hasBottom ? 'text-purple-400' : 'text-zinc-600'}`} />
                  <span>Select Bottom</span>
                </button>
                <div className="h-px bg-zinc-800 my-1" />
                <button
                  type="button"
                  onClick={handleSelectCustom}
                  className="w-full text-left px-3 py-2 text-xs font-medium rounded-xl flex items-center space-x-2 transition-colors text-purple-300 hover:text-white hover:bg-purple-600/30 cursor-pointer"
                  title="Click or drag rectangle to select custom leaf nodes"
                >
                  <MousePointer className="w-3.5 h-3.5 text-purple-400" />
                  <span>Custom</span>
                </button>
              </div>
            )}
          </div>

          <button 
            type="button"
            onClick={handleImportClick}
            className="text-zinc-300 hover:text-white px-3 py-1.5 text-sm font-medium transition-colors flex items-center space-x-1.5 bg-zinc-900 hover:bg-zinc-800 rounded-lg border border-zinc-800 cursor-pointer"
            title="Import ThoughtFlow Mind Map (.json)"
          >
            <Upload className="w-4 h-4 text-purple-400" />
            <span className="hidden sm:inline">Import</span>
          </button>

          <button 
            type="button"
            onClick={exportMap}
            className="text-zinc-300 hover:text-white px-3 py-1.5 text-sm font-medium transition-colors flex items-center space-x-1.5 bg-zinc-900 hover:bg-zinc-800 rounded-lg border border-zinc-800 cursor-pointer"
            title="Export ThoughtFlow Mind Map (.json)"
          >
            <Download className="w-4 h-4 text-purple-400" />
            <span className="hidden sm:inline">Export</span>
          </button>

          <div className="w-px h-6 bg-zinc-800"></div>

          <button 
            type="button"
            onClick={handleClearClick}
            className="text-zinc-400 hover:text-red-400 px-3 py-1.5 text-sm font-medium transition-colors flex items-center space-x-1.5 bg-zinc-900 hover:bg-zinc-800 rounded-lg border border-zinc-800 cursor-pointer"
            title="Clear and start new map"
          >
            <X className="w-4 h-4" />
            <span className="hidden sm:inline">Clear</span>
          </button>
        </div>
      </header>

      {/* Main Workspace (Canvas + Energy Flow Hub + Sidebar) */}
      <div className="grow flex overflow-hidden relative">
        
        {/* TOP-LEFT FLOATING IMPORT HUB (Hidden in Read Mode) */}
        {!isReadMode && (
          <div className="absolute left-6 top-6 z-30 flex items-center select-none import-hub space-x-2">
            
            {/* Import Icon Button */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className={`
                p-2 rounded-xl transition-colors cursor-pointer flex items-center justify-center shadow-lg border h-38px w-38px
                ${isUploading 
                  ? 'bg-purple-900/70 border-purple-400 text-white ring-2 ring-purple-500/40' 
                  : 'bg-zinc-900/90 hover:bg-zinc-800 border-zinc-700/80 hover:border-purple-500 text-zinc-200 hover:text-white'
                }
              `}
              title="Browse & Upload files (images, PDFs, notes)"
            >
              <Upload className="w-4 h-4 text-purple-400" />
            </button>

            {/* Paste Icon Button */}
            <button
              type="button"
              onClick={handleHubPasteClipboard}
              className="p-2 rounded-xl bg-zinc-900/90 hover:bg-zinc-800 border border-zinc-700/80 hover:border-purple-500 text-zinc-200 hover:text-white transition-colors cursor-pointer flex items-center justify-center shadow-lg h-38px w-38px"
              title="Paste Text or Screenshot from clipboard (Ctrl+V)"
            >
              <ClipboardPaste className="w-4 h-4 text-purple-400" />
            </button>

            {/* Imported Files Button */}
            <div 
              className="relative group"
              onMouseEnter={() => setIsFolderMenuOpen(true)}
            >
              <button
                type="button"
                onClick={() => {
                  setIsFolderMenuOpen(!isFolderMenuOpen);
                  setActiveSection('importedFiles');
                }}
                className={`
                  px-3.5 py-2 rounded-xl text-xs font-semibold tracking-wide transition-colors cursor-pointer flex items-center space-x-2.5 shadow-lg border h-38px
                  ${effectiveActiveSection === 'importedFiles'
                    ? 'bg-zinc-900/95 border-purple-500 text-purple-100 ring-2 ring-purple-500/50 shadow-[0_0_20px_rgba(168,85,247,0.35)]'
                    : (importedFiles.length > 0 
                        ? 'bg-zinc-900/95 border-purple-500/60 text-purple-200 ring-1 ring-purple-500/20 hover:border-purple-400' 
                        : 'bg-zinc-900/80 border-zinc-800 text-zinc-400 hover:text-zinc-300'
                      )
                  }
                `}
                title="Click or hover to inspect imported files"
              >
                {isFolderMenuOpen ? (
                  <FolderOpen className="w-4 h-4 text-purple-400" />
                ) : (
                  <Folder className="w-4 h-4 text-purple-400" />
                )}
                <span>Imported Files</span>
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-mono bg-purple-500/20 text-purple-300 border border-purple-500/30">
                  {importedFiles.length}
                </span>
              </button>

              {/* Hover / Click Flyout List of Imported Files */}
              {isFolderMenuOpen && (
                <div 
                  className="absolute left-0 top-full mt-2 w-72 max-h-80 overflow-auto bg-[#0c0c0e]/95 backdrop-blur-xl border border-zinc-700/80 rounded-xl shadow-[0_20px_40px_rgba(0,0,0,0.8)] p-2 z-40 animate-in fade-in slide-in-from-top-2 duration-200"
                  onMouseLeave={() => setIsFolderMenuOpen(false)}
                >
                  <div className="flex items-center justify-between px-2 py-1.5 border-b border-zinc-800 text-xs font-semibold text-zinc-400 mb-1">
                    <span>Imported Files ({importedFiles.length})</span>
                  </div>

                  {importedFiles.length === 0 ? (
                    <div className="p-4 text-center text-xs text-zinc-500 space-y-2">
                      <p>No files imported yet.</p>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {importedFiles.map((file) => (
                        <div
                          key={file.id}
                          onClick={() => setPreviewFile(file)}
                          className={`
                            flex items-center justify-between p-2 rounded-lg text-xs cursor-pointer transition-all border
                            ${previewFile?.id === file.id 
                              ? 'bg-purple-950/40 border-purple-500/50 text-white' 
                              : 'bg-zinc-900/60 hover:bg-zinc-800/80 border-transparent text-zinc-300'
                            }
                          `}
                        >
                          <div className="flex items-center space-x-2 min-w-0 pr-1">
                            {file.type === 'image' && <FileImage className="w-3.5 h-3.5 text-purple-400 shrink-0" />}
                            {file.type === 'pdf' && <FileText className="w-3.5 h-3.5 text-red-400 shrink-0" />}
                            {file.type === 'text' && <FileCode className="w-3.5 h-3.5 text-blue-400 shrink-0" />}
                            <span className="truncate max-w-35" title={file.name}>
                              {file.name}
                            </span>
                          </div>

                          <div className="flex items-center space-x-1 shrink-0">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setPreviewFile(file);
                              }}
                              className="p-1 text-zinc-400 hover:text-purple-300 hover:bg-purple-500/20 rounded"
                              title="Preview file"
                            >
                              <Eye className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => handleDeleteImportedFile(file.id, e)}
                              className="p-1 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded"
                              title="Delete file"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

          </div>
        )}

        {/* 3:4 Vertical Preview Modal on the Left with Zoom Controls and Corner Drag Resizing (Hidden in Read Mode) */}
        {!isReadMode && previewFile && (
          <FilePreviewModal
            file={previewFile}
            allFiles={importedFiles}
            onClose={() => {
              setPreviewFile(null);
              if (!isSidebarOpen) setActiveSection('importedFiles');
            }}
            onSelectFile={(file) => setPreviewFile(file)}
            previewWidth={previewWidth}
            setPreviewWidth={setPreviewWidth}
            sidebarWidth={sidebarWidth}
            isSidebarOpen={isSidebarOpen}
            getFileViewState={getFileViewState}
            saveFileViewState={saveFileViewState}
            onDeleteFile={handleDeleteImportedFile}
            onPasteFiles={processImportFiles}
            activeSection={effectiveActiveSection}
            onSelectSection={setActiveSection}
            isDragTarget={isGlobalDraggingFile && dragTargetZone === 'preview'}
          />
        )}

        {/* Top-Right Floating Controls (when Node Inspector is closed) */}
        {!isSidebarOpen && (
          isReadMode ? (
            <div className="absolute right-6 top-6 z-30 flex flex-col items-center space-y-2">
              <button
                type="button"
                onClick={() => {
                  setIsSidebarOpen(true);
                  setActiveSection('inspector');
                  if (!activeNode && treeData) setActiveNode(treeData);
                }}
                className="p-2.5 rounded-xl bg-zinc-900/90 hover:bg-zinc-800 border border-zinc-700/80 hover:border-purple-500 text-zinc-300 hover:text-white shadow-[0_10px_25px_rgba(0,0,0,0.6)] hover:shadow-purple-500/20 transition-all duration-300 cursor-pointer flex items-center justify-center group"
                title="Open Node Inspector (Ctrl+Alt+X)"
              >
                <PanelRightOpen className="w-5 h-5 text-purple-400 group-hover:scale-110 transition-transform" />
              </button>
              <button
                type="button"
                onClick={() => setSidebarWidth(384)}
                className={`p-2.5 rounded-xl transition-all duration-300 cursor-pointer border flex items-center justify-center shadow-[0_10px_25px_rgba(0,0,0,0.6)] ${
                  sidebarWidth === 384
                    ? 'bg-zinc-900/90 hover:bg-zinc-800 border-zinc-700/80 text-zinc-300 hover:text-white'
                    : 'text-purple-300 bg-purple-500/20 hover:bg-purple-500/30 border-purple-500/50 ring-1 ring-purple-500/30 shadow-[0_0_15px_rgba(168,85,247,0.35)]'
                }`}
                title={sidebarWidth === 384 ? "Inspector is at default size (384px)" : "Reset Inspector size to default"}
              >
                <RotateCcw className={`w-4 h-4 transition-transform duration-300 ${sidebarWidth !== 384 ? 'text-purple-400 rotate-180' : 'text-white'}`} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setIsSidebarOpen(true);
                setActiveSection('inspector');
                if (!activeNode && treeData) setActiveNode(treeData);
              }}
              className="absolute right-6 top-6 z-30 p-2.5 rounded-xl bg-zinc-900/90 hover:bg-zinc-800 border border-zinc-700/80 hover:border-purple-500 text-zinc-300 hover:text-white shadow-[0_10px_25px_rgba(0,0,0,0.6)] hover:shadow-purple-500/20 transition-all duration-300 cursor-pointer flex items-center justify-center group"
              title="Open Node Inspector (Ctrl+Alt+X)"
            >
              <PanelRightOpen className="w-5 h-5 text-purple-400 group-hover:scale-110 transition-transform" />
            </button>
          )
        )}

        {/* Tree Canvas */}
        <main 
          ref={canvasRef}
          style={{
            marginRight: isSidebarOpen ? `${sidebarWidth}px` : '0px',
            transition: isSidebarResizing ? 'none' : 'margin-right 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
          }}
          className={`
            grow relative overflow-auto no-scrollbar
            ${isCanvasDragging ? 'cursor-grabbing' : (draggingNodeId ? 'cursor-grabbing' : 'cursor-grab')}
            bg-[radial-gradient(#27272a_1px,transparent_1px)] bg-size-[24px_24px] select-none
          `}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onMouseMove={handleMouseMove}
          onScroll={(e) => {
            if (!pendingZoomScrollRef.current) {
              canvasViewStateRef.current = {
                scrollLeft: e.currentTarget.scrollLeft,
                scrollTop: e.currentTarget.scrollTop
              };
            }
          }}
        >
          {/* Zoom Layout Wrapper (represents the scaled visual dimensions of the entire workspace) */}
          <div 
            className="relative"
            style={{
              width: `${Math.ceil((workspacePadding.left + workspacePadding.right + 4800) * zoomLevel)}px`,
              height: `${Math.ceil((workspacePadding.top + workspacePadding.bottom + 3600) * zoomLevel)}px`,
              minWidth: '100%',
              minHeight: '100%'
            }}
          >
            {treeData && (
              /* Scaled Mind Map Layer */
              <div 
                ref={treeContainerRef} 
                className="mind-map-root absolute top-0 left-0"
                style={{
                  width: `${workspacePadding.left + workspacePadding.right + 4800}px`,
                  height: `${workspacePadding.top + workspacePadding.bottom + 3600}px`,
                  transform: `scale(${zoomLevel})`,
                  transformOrigin: 'top left'
                }}
              >
                {/* Unscaled Workspace Offset Container */}
                <div 
                  className="relative w-full h-full"
                  style={{
                    position: 'absolute',
                    left: `${workspacePadding.left}px`,
                    top: `${workspacePadding.top}px`
                  }}
                >
                  {/* Dedicated SVG Curved Mind-Map Connectors */}
                  <svg 
                    className="absolute inset-0 w-full h-full pointer-events-none z-0 overflow-visible"
                    style={{ width: '100%', height: '100%' }}
                  >
                    <defs>
                      <linearGradient id="mindMapGlow" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#a855f7" stopOpacity="0.6" />
                        <stop offset="100%" stopColor="#6366f1" stopOpacity="0.6" />
                      </linearGradient>
                    </defs>
                    {connectorPaths.map(p => (
                      <g key={p.id}>
                        {/* Subtle purple aura glow */}
                        <path
                          d={p.d}
                          stroke="var(--tf-connector-glow)"
                          strokeWidth="6"
                          fill="none"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        {/* Crisp main curved path */}
                        <path
                          d={p.d}
                          stroke="var(--tf-connector-stroke)"
                          strokeWidth="2.5"
                          fill="none"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        {/* Origin & target connector anchor nodes */}
                        <circle cx={p.x1} cy={p.y1} r="3" fill="var(--tf-connector-anchor)" />
                        <circle cx={p.x2} cy={p.y2} r="3" fill="var(--tf-connector-anchor)" />
                      </g>
                    ))}
                  </svg>

                  {/* Free-form Absolute Draggable Nodes */}
                  {allNodes.map(node => {
                    const isTargetDragged = draggingNodeId === node.id;
                    const isGroupDragged = !!draggingNodeId && selectedNodeIds.has(node.id) && selectedNodeIds.size > 1;
                    const isNodeActivelyDragged = isTargetDragged || isGroupDragged;

                    return (
                      <MindMapNode 
                        key={node.id} 
                        node={node} 
                        activeNodeId={activeNode?.id} 
                        isSelected={selectedNodeIds.has(node.id)}
                        isDragging={draggingNodeId === node.id}
                        dragOffset={isNodeActivelyDragged ? liveDragOffset : null}
                        isCollapsed={collapsedNodeIds.has(node.id)}
                        onToggleCollapse={handleToggleCollapse}
                        onNodeMouseDown={handleNodeMouseDown}
                        onNodeClick={handleNodeClick} 
                        onDeleteNode={handleDeleteNode}
                        onOpenMediaTab={handleOpenMediaTab}
                        isReadMode={isReadMode}
                        isFloatingMediaOpen={isFloatingMediaOpen}
                        onCreateNodeInDirection={handleCreateNodeInDirection}
                        onMeasureDimensions={handleMeasureDimensions}
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </main>

        {/* Box Selection Marquee Box */}
        {selectionBox && (
          <div
            style={{
              position: 'fixed',
              left: `${Math.min(selectionBox.startX, selectionBox.currentX)}px`,
              top: `${Math.min(selectionBox.startY, selectionBox.currentY)}px`,
              width: `${Math.abs(selectionBox.currentX - selectionBox.startX)}px`,
              height: `${Math.abs(selectionBox.currentY - selectionBox.startY)}px`,
              pointerEvents: 'none',
              zIndex: 99999
            }}
            className="border-2 border-purple-500 bg-purple-500/15 rounded-lg backdrop-blur-[1px] shadow-[0_0_15px_rgba(168,85,247,0.35)]"
          />
        )}

        {/* Global Sidebar Resize Drag Overlay Mask */}
        {isSidebarResizing && (
          <div className="fixed inset-0 z-99999 cursor-ew-resize select-none pointer-events-auto bg-transparent" />
        )}

        {/* Node Inspector Sidebar */}
        <aside 
          onClick={() => setActiveSection('inspector')}
          style={{
            width: `${sidebarWidth}px`,
            transition: isSidebarResizing ? 'none' : 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.3s ease'
          }}
          className={`
            absolute right-0 top-0 h-full max-w-[50vw] bg-[#0c0c0e]/95 backdrop-blur-xl flex flex-col z-20 transition-all duration-200
            ${draggingNodeId ? 'pointer-events-none opacity-85' : ''}
            ${isGlobalDraggingFile && dragTargetZone === 'photos'
              ? 'border-l-2 border-purple-500 ring-2 ring-purple-500/80 shadow-[-10px_0_40px_rgba(168,85,247,0.5)]'
              : (effectiveActiveSection === 'inspector'
                  ? 'border-l-2 border-l-purple-500 ring-2 ring-purple-500/40 shadow-[-10px_0_35px_rgba(168,85,247,0.35)]'
                  : 'border-l border-zinc-800 shadow-[-10px_0_30px_rgba(0,0,0,0.6)]'
                )
            }
            ${isSidebarOpen ? 'translate-x-0' : 'translate-x-full'}
          `}
        >
          {/* Left-Edge Drag Resize Handle for Node Inspector */}
          <div
            onMouseDown={handleSidebarResizeMouseDown}
            className="absolute top-0 -left-2 w-4 h-full cursor-ew-resize hover:bg-purple-500/40 active:bg-purple-500/60 transition-colors z-30 group flex items-center justify-center"
            title="Hold & drag left edge to resize Node Inspector (up to half of the screen)"
          >
            <div className="w-1 h-12 rounded-full bg-zinc-600 group-hover:bg-purple-400 group-hover:scale-y-125 transition-all opacity-0 group-hover:opacity-100 shadow-lg" />
          </div>

          {/* Read Mode: Attached Controls on the LEFT Side of the Node Inspector Panel (Follows Inspector on X-Axis & Resizing) */}
          {isReadMode && isSidebarOpen && (
            <div className="absolute right-full top-6 mr-3 z-30 flex flex-col items-center space-y-2 pointer-events-auto">
              <button
                type="button"
                onClick={() => {
                  setIsSidebarOpen(false);
                  setActiveSection('importedFiles');
                }}
                className="p-2.5 rounded-xl bg-zinc-900/90 hover:bg-zinc-800 border border-zinc-700/80 hover:border-purple-500 text-zinc-300 hover:text-white shadow-[0_10px_25px_rgba(0,0,0,0.6)] hover:shadow-purple-500/20 transition-all duration-300 cursor-pointer flex items-center justify-center group"
                title="Close Node Inspector (Ctrl+Alt+X)"
              >
                <PanelRightClose className="w-5 h-5 text-purple-400 group-hover:scale-110 transition-transform" />
              </button>
              <button
                type="button"
                onClick={() => setSidebarWidth(384)}
                className={`p-2.5 rounded-xl transition-all duration-300 cursor-pointer border flex items-center justify-center shadow-[0_10px_25px_rgba(0,0,0,0.6)] ${
                  sidebarWidth === 384
                    ? 'bg-zinc-900/90 hover:bg-zinc-800 border-zinc-700/80 text-zinc-300 hover:text-white'
                    : 'text-purple-300 bg-purple-500/20 hover:bg-purple-500/30 border-purple-500/50 ring-1 ring-purple-500/30 shadow-[0_0_15px_rgba(168,85,247,0.35)]'
                }`}
                title={sidebarWidth === 384 ? "Inspector is at default size (384px)" : "Reset Inspector size to default"}
              >
                <RotateCcw className={`w-4 h-4 transition-transform duration-300 ${sidebarWidth !== 384 ? 'text-purple-400 rotate-180' : 'text-white'}`} />
              </button>
            </div>
          )}

          {selectedNodeIds.size > 1 ? (
            <div className="flex flex-col h-full">
              {/* Multi-Selection Sidebar Header */}
              <div className="p-4 border-b border-zinc-800 bg-zinc-900/60 flex items-center justify-between">
                <div className="grow mr-2">
                  <div className="text-xs font-semibold text-purple-400 tracking-wider mb-1 flex items-center space-x-1.5">
                    <CheckSquare className="w-3.5 h-3.5" />
                    <span>MULTI-SELECTION ({selectedNodeIds.size} NODES)</span>
                  </div>
                  <input 
                    type="text" 
                    value={activeNode?.text || ''}
                    onChange={(e) => handleBulkUpdateText(e.target.value)}
                    className="w-full bg-zinc-800/60 border border-zinc-700/50 rounded-lg px-3 py-1.5 text-base font-medium text-white focus:outline-none focus:ring-1 focus:ring-purple-500 transition-all font-mono"
                    placeholder="Rename all selected nodes..."
                  />
                </div>
                <div className="flex items-center space-x-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={handleBulkDeleteNodes}
                    className="p-2 text-zinc-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg border border-zinc-800 hover:border-red-500/30 transition-all cursor-pointer flex items-center justify-center"
                    title={`Delete all ${selectedNodeIds.size} selected nodes`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedNodeIds(new Set())}
                    className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg border border-zinc-800 transition-colors cursor-pointer flex items-center justify-center text-xs font-medium"
                    title="Clear selection"
                  >
                    <X className="w-4 h-4 text-zinc-400" />
                  </button>
                </div>
              </div>

              {/* Multi-selection summary content */}
              <div className="grow p-5 text-zinc-400 space-y-4 overflow-y-auto">
                <div className="p-3.5 bg-purple-500/10 border border-purple-500/30 rounded-xl text-xs space-y-1.5 text-purple-200">
                  <p className="font-semibold text-purple-300 flex items-center space-x-1.5">
                    <CheckSquare className="w-4 h-4" />
                    <span>Group Action Active</span>
                  </p>
                  <p className="text-zinc-300">
                    Dragging any selected node moves the entire group with preserved relative spacing.
                  </p>
                  <p className="text-zinc-400">
                    Editing the title above renames all {selectedNodeIds.size} selected nodes simultaneously.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                    Selected Nodes
                  </div>
                  <div className="space-y-1 max-h-60 overflow-y-auto no-scrollbar">
                    {Array.from(selectedNodeIds).map(id => {
                      const n = findNodeById(treeData, id);
                      if (!n) return null;
                      return (
                        <div key={id} className="px-3 py-1.5 bg-zinc-900/90 border border-zinc-800 rounded-lg text-xs font-mono text-zinc-300 flex items-center justify-between">
                          <span className="truncate">{n.text || 'Untitled'}</span>
                          <span className="text-[10px] text-zinc-500 uppercase">{n.side || 'down'}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          ) : activeNode ? (
            <div className="flex flex-col h-full">
              
              {/* Sidebar Header (Normal Mode Only; completely removed in Read Mode) */}
              {!isReadMode && (
                <div className="p-4 border-b border-zinc-800 bg-zinc-900/60 flex items-center justify-between">
                  <div className="grow mr-2">
                    <div className="text-xs font-semibold text-zinc-500 tracking-wider mb-1 truncate">
                      {activeNode.id === treeData?.id
                        ? 'Root Node'
                        : `FROM ${findParentNode(treeData, activeNode.id)?.text ?? 'Parent'}`}
                    </div>
                    <input 
                      type="text" 
                      value={activeNode.text}
                      onChange={(e) => handleUpdateNode({ text: e.target.value })}
                      className="w-full bg-zinc-800/60 border border-zinc-700/50 rounded-lg px-3 py-1.5 text-base font-medium text-white focus:outline-none focus:ring-1 focus:ring-purple-500 transition-all font-mono"
                      placeholder="Node title..."
                    />
                  </div>
                  <div className="flex items-center space-x-1.5 shrink-0">
                    {activeNode.id !== treeData?.id && (
                      <button
                        type="button"
                        onClick={() => handleDeleteNode(activeNode.id)}
                        className="p-2 text-zinc-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg border border-zinc-800 hover:border-red-500/30 transition-all cursor-pointer flex items-center justify-center"
                        title="Delete this node/branch"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                    
                    <div className="flex flex-col items-center space-y-1.5">
                      <button
                        type="button"
                        onClick={() => setSidebarWidth(384)}
                        className={`p-2 rounded-lg transition-all duration-300 cursor-pointer border flex items-center justify-center ${
                          sidebarWidth === 384
                            ? 'text-white bg-zinc-800/80 hover:bg-zinc-700/80 border-zinc-700/60'
                            : 'text-purple-300 bg-purple-500/20 hover:bg-purple-500/30 border-purple-500/50 ring-1 ring-purple-500/30 shadow-[0_0_15px_rgba(168,85,247,0.35)]'
                        }`}
                        title={sidebarWidth === 384 ? "Inspector is at default size (384px)" : "Reset Inspector size to default"}
                      >
                        <RotateCcw className={`w-4 h-4 transition-transform duration-300 ${sidebarWidth !== 384 ? 'text-purple-400 rotate-180' : 'text-white'}`} />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setIsSidebarOpen(false);
                          setActiveSection('importedFiles');
                        }}
                        className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 bg-zinc-800/60 rounded-lg border border-zinc-700/60 transition-colors cursor-pointer flex items-center justify-center"
                        title="Close Node Inspector (Ctrl+Alt+X)"
                      >
                        <PanelRightClose className="w-4 h-4 text-purple-400" />
                      </button>
                    </div>
                  </div>
                </div>
              )}


              {/* Sidebar Tabs (Normal Mode Only; hidden in Read Mode for clean unobstructed reading) */}
              {!isReadMode && (
                <div className="flex border-b border-zinc-800 bg-zinc-900/30">
                  <button 
                    type="button"
                    onClick={() => setSidebarTab('notes')}
                    className={`flex-1 py-3 text-sm font-medium flex items-center justify-center space-x-1.5 border-b-2 transition-colors cursor-pointer ${sidebarTab === 'notes' ? 'border-purple-500 text-purple-400 bg-purple-500/5' : 'border-transparent text-zinc-400 hover:text-zinc-200'}`}
                  >
                    <FileText className="w-4 h-4" /> <span>Notes</span>
                  </button>
                  <button 
                    type="button"
                    onClick={() => setSidebarTab('photos')}
                    className={`flex-1 py-3 text-sm font-medium flex items-center justify-center space-x-1.5 border-b-2 transition-colors cursor-pointer ${sidebarTab === 'photos' ? 'border-purple-500 text-purple-400 bg-purple-500/5' : 'border-transparent text-zinc-400 hover:text-zinc-200'}`}
                  >
                    <FileImage className="w-4 h-4" /> 
                    <span>Photos</span>
                    {activeNode.images && activeNode.images.length > 0 && (
                      <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-purple-500/20 text-purple-300 border border-purple-500/30 ml-1">
                        {activeNode.images.length}
                      </span>
                    )}
                  </button>
                </div>
              )}

              {/* Sidebar Content (Preserves Notes and Photos Preview state across tab switches) */}
              <div className="grow p-4 overflow-hidden relative">
                <div className={`w-full h-full flex-col ${isReadMode || sidebarTab === 'notes' ? 'flex' : 'hidden'}`}>
                  <RichTextEditor 
                    key={`notes-${activeNode.id}`} 
                    initialContent={activeNode.notes}
                    onChange={(content) => handleUpdateNode({ notes: content })}
                  />
                </div>
                {!isReadMode && (
                  <div className={`w-full h-full flex-col ${sidebarTab === 'photos' ? 'flex' : 'hidden'}`}>
                    <NodePhotosManager
                      key={`photos-${activeNode.id}`}
                      images={activeNode.images || []}
                      onAddImages={(files) => processNodeImages(files, activeNode)}
                      onDeleteImage={(imageId) => {
                        const remaining = (activeNode.images || []).filter(img => img.id !== imageId);
                        handleUpdateNode({ images: remaining });
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-zinc-500 p-8 text-center space-y-4">
              <Sparkles className="w-12 h-12 text-zinc-700" />
              <p>Select any node in the map to edit title, add rich notes, or attach photos.</p>
            </div>
          )}
        </aside>


      </div>

      {/* Floating Draggable & Resizable Media Window in Read Mode */}
      {isReadMode && activeNode && (
        <FloatingMediaWindow
          activeNode={activeNode}
          isOpen={isFloatingMediaOpen}
          onClose={() => setIsFloatingMediaOpen(false)}
          onUpdateNode={handleUpdateNode}
          processNodeImages={processNodeImages}
        />
      )}

      {/* TOPMOST FLOATING DRAGGABLE CONTROL PANEL - "Add Thought / Branching" (Hidden in Read Mode) */}
      {!isReadMode && activeNode && (
        <div 
          ref={thoughtBoxRef}
          style={thoughtBoxPos ? {
            position: 'fixed',
            left: 0,
            top: 0,
            bottom: 'auto',
            right: 'auto',
            transform: `translate3d(${thoughtBoxPos.x}px, ${thoughtBoxPos.y}px, 0)`,
            zIndex: 9999
          } : {
            position: 'fixed',
            bottom: '24px',
            left: '50%',
            transform: 'translate3d(-50%, 0, 0)',
            zIndex: 9999
          }}
          className={`select-none transition-opacity duration-150 ${
            isThoughtBoxCollapsed ? 'w-auto' : 'thought-creation-box w-[92vw] max-w-xl'
          }`}
        >
          {isThoughtBoxCollapsed ? (
            /* Collapsed State: Only Draggable Hexagonal Toggle Handle */
            <div className="flex items-center justify-center">
              <div
                role="button"
                tabIndex={0}
                onPointerDown={handleHexPointerDown}
                onPointerMove={handleHexPointerMove}
                onPointerUp={handleHexPointerUp}
                onPointerCancel={handleHexPointerUp}
                style={{ touchAction: 'none' }}
                className={`group relative flex items-center justify-center cursor-grab active:cursor-grabbing select-none transition-transform duration-150 hover:scale-110 active:scale-95 ${
                  isDraggingHex ? 'cursor-grabbing scale-105' : ''
                }`}
                title="Click to expand Node Maker (Branching) | Drag to reposition"
              >
                {/* Glow ring */}
                <div className={`absolute inset-0 rounded-full bg-purple-500/30 blur-md transition-opacity ${isDraggingHex ? 'opacity-100 bg-purple-500/60' : 'opacity-50 group-hover:opacity-100'}`} />

                {/* Hexagon SVG */}
                <svg 
                  viewBox="0 0 42 36" 
                  className="w-42px h-36px filter drop-shadow-[0_6px_16px_rgba(0,0,0,0.95)] relative z-10"
                >
                  <polygon 
                    points="21,2 39,10 39,26 21,34 3,26 3,10" 
                    className={`transition-colors duration-150 ${
                      isDraggingHex
                        ? 'fill-[#1c1427] stroke-purple-400'
                        : 'fill-[#121216]/95 stroke-purple-500/80 group-hover:stroke-purple-300 group-hover:fill-[#1b1822]'
                    }`}
                    strokeWidth="1.8"
                    strokeLinejoin="round"
                  />
                </svg>

                {/* Centered expand icon */}
                <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
                  <ChevronUp className="w-4 h-4 text-purple-300 group-hover:text-white transition-transform group-hover:-translate-y-0.5" strokeWidth={2.5} />
                </div>
              </div>
            </div>
          ) : (
            /* Expanded State: Full Thought Creation Box with Attached Hexagonal Handle */
            <div className="relative animate-in fade-in zoom-in-95 duration-150">
              <div className="bg-zinc-900/95 border border-zinc-700/80 backdrop-blur-2xl rounded-2xl p-4 ring-1 ring-purple-500/30">
                
                {/* Draggable Header Handle */}
                <div 
                  onMouseDown={handleThoughtBoxDragStart}
                  className="flex items-center justify-between text-xs md:text-sm pb-2 mb-2 border-b border-zinc-800/80 cursor-grab active:cursor-grabbing text-zinc-400 group"
                  title="Hold & drag to move this box anywhere on the screen"
                >
                  <div className="flex items-center space-x-2 overflow-hidden mr-2">
                    <GripHorizontal className="w-4 h-4 text-zinc-500 group-hover:text-purple-400 transition-colors shrink-0" />
                    <GitBranch className="w-4 h-4 text-purple-400 shrink-0" />
                    <span className="truncate">Branching from: <strong className="text-purple-200 font-mono tracking-wide">{activeNode.text || 'Untitled'}</strong></span>
                  </div>

                  {/* Direction Selector Switcher */}
                  <div className="flex items-center space-x-1 bg-zinc-950 p-0.5 rounded-lg border border-zinc-800 text-[11px] no-drag shrink-0">
                    <button
                      type="button"
                      onClick={() => setActiveCreationDirection('bottom')}
                      className={`px-2 py-0.5 rounded flex items-center space-x-1 transition-all cursor-pointer ${
                        activeCreationDirection === 'bottom'
                          ? 'bg-purple-600 text-white shadow font-medium'
                          : 'text-zinc-400 hover:text-white'
                      }`}
                      title="Create new nodes below (Vertical Branch ↓)"
                    >
                      <ChevronDown size={12} />
                      <span>Below</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveCreationDirection('right')}
                      className={`px-2 py-0.5 rounded flex items-center space-x-1 transition-all cursor-pointer ${
                        activeCreationDirection === 'right'
                          ? 'bg-purple-600 text-white shadow font-medium'
                          : 'text-zinc-400 hover:text-white'
                      }`}
                      title="Create new nodes to the right (Horizontal Branch →)"
                    >
                      <ArrowRight size={12} />
                      <span>Right</span>
                    </button>
                  </div>
                </div>

                <form onSubmit={handleAddThought} className="flex items-center space-x-2">
                  <input
                    type="text"
                    value={newThoughtText}
                    onChange={(e) => setNewThoughtText(e.target.value)}
                    placeholder={activeCreationDirection === 'right' ? "Enter concept to connect on the right (→)..." : "Enter concept to connect below (↓)..."}
                    className="grow bg-black/60 border border-zinc-700 text-white rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-purple-500 transition-all text-sm placeholder:text-zinc-500 font-mono"
                    autoFocus
                  />
                  <button 
                    type="submit"
                    disabled={!newThoughtText.trim()}
                    className="p-3 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:hover:bg-purple-600 text-white rounded-xl transition-all flex-shrink-0 shadow-lg shadow-purple-900/30 cursor-pointer"
                    title={activeCreationDirection === 'right' ? "Add Node to Right (→)" : "Add Node Below (↓)"}
                  >
                    <Plus className="w-5 h-5" />
                  </button>
                </form>
              </div>

              {/* Hexagonal Handle Attached Exactly at Center of Bottom Border */}
              <div className="absolute left-1/2 -bottom-4 -translate-x-1/2 z-20">
                <div
                  role="button"
                  tabIndex={0}
                  onPointerDown={handleHexPointerDown}
                  onPointerMove={handleHexPointerMove}
                  onPointerUp={handleHexPointerUp}
                  onPointerCancel={handleHexPointerUp}
                  style={{ touchAction: 'none' }}
                  className={`group relative flex items-center justify-center cursor-grab active:cursor-grabbing select-none transition-transform duration-150 hover:scale-110 active:scale-95 ${
                    isDraggingHex ? 'cursor-grabbing scale-105' : ''
                  }`}
                  title="Click to collapse Node Maker | Drag to reposition"
                >
                  {/* Glow ring */}
                  <div className={`absolute inset-0 rounded-full bg-purple-500/30 blur-md transition-opacity ${isDraggingHex ? 'opacity-100 bg-purple-500/60' : 'opacity-40 group-hover:opacity-100'}`} />

                  {/* Hexagon SVG */}
                  <svg 
                    viewBox="0 0 42 36" 
                    className="w-10.5 h-9 filter drop-shadow-[0_6px_16px_rgba(0,0,0,0.95)] relative z-10"
                  >
                    <polygon 
                      points="21,2 39,10 39,26 21,34 3,26 3,10" 
                      className={`transition-colors duration-150 ${
                        isDraggingHex
                          ? 'fill-[#1c1427] stroke-purple-400'
                          : 'fill-[#121216]/95 stroke-purple-500/80 group-hover:stroke-purple-300 group-hover:fill-[#1b1822]'
                      }`}
                      strokeWidth="1.8"
                      strokeLinejoin="round"
                    />
                  </svg>

                  {/* Centered collapse icon */}
                  <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
                    <ChevronDown className="w-4 h-4 text-purple-300 group-hover:text-white transition-transform group-hover:translate-y-0.5" strokeWidth={2.5} />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Delete Confirmation Warning Modal for Parent Nodes with Children */}
      {nodeToDelete && (
        <div 
          className="fixed inset-0 z-999999 flex items-center justify-center bg-black/75 backdrop-blur-sm animate-in fade-in duration-200 select-none p-4"
          onClick={() => setNodeToDelete(null)}
        >
          <div 
            className="bg-[#121215] border border-zinc-700/80 rounded-2xl shadow-[0_25px_70px_rgba(0,0,0,0.85)] max-w-md w-full p-6 text-zinc-200 animate-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start space-x-4">
              <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-amber-400 shrink-0">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div className="space-y-2 grow min-w-0">
                <h3 className="text-lg font-semibold text-white tracking-wide">
                  Delete Node & Branches?
                </h3>
                <p className="text-sm text-zinc-300 leading-relaxed">
                  Are you sure you want to delete <strong className="text-white">"{nodeToDelete.text || 'Untitled Node'}"</strong>?
                </p>
                <p className="text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/20 p-2.5 rounded-lg">
                  This node has child nodes. Deleting it will also remove its connected child branches.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end space-x-3 mt-6 pt-4 border-t border-zinc-800/80">
              <button
                type="button"
                onClick={() => setNodeToDelete(null)}
                className="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-white bg-zinc-800 hover:bg-zinc-700 rounded-xl transition-colors cursor-pointer border border-zinc-700/60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => executeDeleteNode(nodeToDelete.id)}
                className="px-4 py-2 text-sm font-semibold text-white bg-red-600 hover:bg-red-500 rounded-xl transition-all shadow-lg shadow-red-950/50 cursor-pointer flex items-center space-x-1.5"
              >
                <Trash2 className="w-4 h-4" />
                <span>Delete</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clear Mind Map Unsaved Changes Warning Modal */}
      {showClearWarningModal && (
        <div 
          className="fixed inset-0 z-999999 flex items-center justify-center bg-black/75 backdrop-blur-sm animate-in fade-in duration-200 select-none p-4"
          onClick={() => setShowClearWarningModal(false)}
        >
          <div 
            className="bg-[#121215] border border-zinc-700/80 rounded-2xl shadow-[0_25px_70px_rgba(0,0,0,0.85)] max-w-md w-full p-6 text-zinc-200 animate-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start space-x-4">
              <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-amber-400 shrink-0">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div className="space-y-2 grow min-w-0">
                <h3 className="text-lg font-semibold text-white tracking-wide">
                  Unsaved Changes
                </h3>
                <p className="text-sm text-zinc-300 leading-relaxed">
                  Your changes will not be saved. Are you sure you want to clear the mind map?
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end space-x-3 mt-6 pt-4 border-t border-zinc-800/80">
              <button
                type="button"
                onClick={() => setShowClearWarningModal(false)}
                className="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-white bg-zinc-800 hover:bg-zinc-700 rounded-xl transition-colors cursor-pointer border border-zinc-700/60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowClearWarningModal(false);
                  resetFlow();
                }}
                className="px-4 py-2 text-sm font-semibold text-white bg-red-600 hover:bg-red-500 rounded-xl transition-all shadow-lg shadow-red-950/50 cursor-pointer flex items-center space-x-1.5"
              >
                <Trash2 className="w-4 h-4" />
                <span>Clear</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import Unsaved Changes Warning Modal */}
      {showImportWarningModal && (
        <div 
          className="fixed inset-0 z-999999 flex items-center justify-center bg-black/75 backdrop-blur-sm animate-in fade-in duration-200 select-none p-4"
          onClick={() => setShowImportWarningModal(false)}
        >
          <div 
            className="bg-[#121215] border border-zinc-700/80 rounded-2xl shadow-[0_25px_70px_rgba(0,0,0,0.85)] max-w-md w-full p-6 text-zinc-200 animate-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start space-x-4">
              <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-amber-400 shrink-0">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div className="space-y-2 grow min-w-0">
                <h3 className="text-lg font-semibold text-white tracking-wide">
                  Import another note?
                </h3>
                <p className="text-sm text-zinc-300 leading-relaxed">
                  Your current changes will be lost if you import another note.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end space-x-3 mt-6 pt-4 border-t border-zinc-800/80">
              <button
                type="button"
                onClick={() => setShowImportWarningModal(false)}
                className="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-white bg-zinc-800 hover:bg-zinc-700 rounded-xl transition-colors cursor-pointer border border-zinc-700/60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmImportWarning}
                className="px-4 py-2 text-sm font-semibold text-white bg-purple-600 hover:bg-purple-500 rounded-xl transition-all shadow-lg shadow-purple-950/50 cursor-pointer flex items-center space-x-1.5"
              >
                <Upload className="w-4 h-4" />
                <span>Import</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Invalid Mind Map Error Modal */}
      {importError && (
        <div 
          className="fixed inset-0 z-999999 flex items-center justify-center bg-black/75 backdrop-blur-sm animate-in fade-in duration-200 select-none p-4"
          onClick={() => setImportError(null)}
        >
          <div 
            className="bg-[#121215] border border-red-500/40 rounded-2xl shadow-[0_25px_70px_rgba(0,0,0,0.85)] max-w-sm w-full p-6 text-zinc-200 animate-in zoom-in-95 duration-200 text-center space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-12 h-12 rounded-full bg-red-500/15 border border-red-500/30 text-red-400 flex items-center justify-center mx-auto">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">Import Failed</h3>
              <p className="text-sm text-zinc-400 mt-1">{importError}</p>
            </div>
            <button
              type="button"
              onClick={() => setImportError(null)}
              className="w-full py-2 text-sm font-medium bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl transition-colors border border-zinc-700 cursor-pointer"
            >
              OK
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
