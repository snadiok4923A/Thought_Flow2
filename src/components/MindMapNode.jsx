import React, {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
} from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileImage,
  FileText,
  Layers,
  Plus,
} from 'lucide-react';

import { hasTextContent } from '../utils/treeUtils';

/**
 * Custom comparison for React.memo.
 *
 * Important:
 * We compare every value that can visually affect this component.
 * Child arrays themselves don't need deep comparison because their
 * length is enough for this component's UI.
 */
const mindMapNodePropsAreEqual = (prev, next) => {
  // Primitive / state props
  if (
    prev.activeNodeId !== next.activeNodeId ||
    prev.isSelected !== next.isSelected ||
    prev.isDragging !== next.isDragging ||
    prev.isCollapsed !== next.isCollapsed ||
    prev.isReadMode !== next.isReadMode ||
    prev.isFloatingMediaOpen !== next.isFloatingMediaOpen
  ) {
    return false;
  }

  // Drag offset
  const prevDx = prev.dragOffset?.dx ?? 0;
  const prevDy = prev.dragOffset?.dy ?? 0;
  const nextDx = next.dragOffset?.dx ?? 0;
  const nextDy = next.dragOffset?.dy ?? 0;

  if (prevDx !== nextDx || prevDy !== nextDy) {
    return false;
  }

  const pNode = prev.node;
  const nNode = next.node;

  // Basic node data
  if (
    pNode === nNode
  ) {
    return true;
  }

  if (
    pNode.id !== nNode.id ||
    pNode.text !== nNode.text ||
    pNode.x !== nNode.x ||
    pNode.y !== nNode.y ||
    pNode.notes !== nNode.notes
  ) {
    return false;
  }

  // Only the lengths are used by this component.
  const pRightCount = pNode.rightChildren?.length ?? 0;
  const nRightCount = nNode.rightChildren?.length ?? 0;

  if (pRightCount !== nRightCount) {
    return false;
  }

  const pBottomCount = pNode.children?.length ?? 0;
  const nBottomCount = nNode.children?.length ?? 0;

  if (pBottomCount !== nBottomCount) {
    return false;
  }

  const pImageCount = pNode.images?.length ?? 0;
  const nImageCount = nNode.images?.length ?? 0;

  if (pImageCount !== nImageCount) {
    return false;
  }

  return true;
};

const MindMapNode = memo(
  ({
    node,
    activeNodeId,
    isSelected = false,
    isDragging = false,
    dragOffset = null,
    isCollapsed = false,
    onToggleCollapse,
    onNodeMouseDown,
    onNodeClick,
    onDeleteNode,
    onOpenMediaTab,
    isReadMode = false,
    isFloatingMediaOpen = false,
    onCreateNodeInDirection,
    onMeasureDimensions,
  }) => {
    const nodeRef = useRef(null);

    /*
     * Browser click events already expose e.detail:
     *
     * 1 = first click
     * 2 = double click
     * 3 = triple click
     *
     * Therefore we don't need our own click timer.
     */
    const handleCardClick = useCallback(
      (e) => {
        // Ignore clicks originating from interactive controls.
        if (
          e.target.closest(
            'button, [title*="Open"], [title*="Create"], [title*="Collapse"], [title*="Expand"]'
          )
        ) {
          return;
        }

        e.stopPropagation();

        // Triple-click
        if (e.detail >= 3) {
          if (isReadMode) {
            onNodeClick?.(node, e);
            return;
          }

          onDeleteNode?.(node.id);
          return;
        }

        onNodeClick?.(node, e);
      },
      [
        isReadMode,
        node,
        onNodeClick,
        onDeleteNode,
      ]
    );

    const handleToggleCollapse = useCallback(
      (e) => {
        e.stopPropagation();
        onToggleCollapse?.(node.id);
      },
      [node.id, onToggleCollapse]
    );

    const handleCreateRight = useCallback(
      (e) => {
        e.stopPropagation();
        onCreateNodeInDirection?.(node, 'right');
      },
      [node, onCreateNodeInDirection]
    );

    const handleCreateBottom = useCallback(
      (e) => {
        e.stopPropagation();
        onCreateNodeInDirection?.(node, 'bottom');
      },
      [node, onCreateNodeInDirection]
    );

    const handleOpenNotes = useCallback(
      (e) => {
        e.stopPropagation();

        if (onOpenMediaTab) {
          onOpenMediaTab(node, 'notes');
        } else {
          onNodeClick?.(node, e);
        }
      },
      [node, onOpenMediaTab, onNodeClick]
    );

    const handleOpenPhotos = useCallback(
      (e) => {
        e.stopPropagation();

        if (onOpenMediaTab) {
          onOpenMediaTab(node, 'photos');
        } else {
          onNodeClick?.(node, e);
        }
      },
      [node, onOpenMediaTab, onNodeClick]
    );

    /**
     * Derived state
     */
    const isNodeSelected =
      isSelected || node.id === activeNodeId;

    const hasNotes = hasTextContent(node.notes);

    const imageCount = node.images?.length ?? 0;
    const hasImages = imageCount > 0;

    const rightCount = node.rightChildren?.length ?? 0;
    const bottomCount = node.children?.length ?? 0;

    const totalChildCount =
      rightCount + bottomCount;

    const hasChildNodes =
      totalChildCount > 0;

    const showReadModeMediaOpener =
      isReadMode &&
      !isFloatingMediaOpen &&
      !hasImages;

    const showAnyIndicator =
      hasNotes ||
      hasImages ||
      showReadModeMediaOpener;

    /**
     * Measure the actual DOM dimensions.
     *
     * offsetWidth/offsetHeight are unaffected by CSS transforms,
     * which is useful because node positions are stored in world
     * coordinates.
     */
    useLayoutEffect(() => {
      const element = nodeRef.current;

      if (!element || !onMeasureDimensions) {
        return;
      }

      const width = element.offsetWidth;
      const height = element.offsetHeight;

      if (width > 0 && height > 0) {
        onMeasureDimensions(
          node.id,
          width,
          height
        );
      }
    }, [
      node.id,
      node.text,
      totalChildCount,
      isCollapsed,
      showAnyIndicator,
      onMeasureDimensions,
    ]);

    const xPos =
      typeof node.x === 'number'
        ? node.x
        : 650;

    const yPos =
      typeof node.y === 'number'
        ? node.y
        : 260;

    const nodeTransform = dragOffset
      ? `translate(${dragOffset.dx}px, ${dragOffset.dy}px)`
      : undefined;

    return (
      <div
        id={`node-${node.id}`}
        data-node-id={node.id}
        style={{
          position: 'absolute',
          left: xPos,
          top: yPos,
          transform: nodeTransform,
          zIndex: isDragging
            ? 40
            : isNodeSelected
              ? 30
              : 10,
        }}
        className="mind-map-node select-none inline-flex flex-col items-center group/node"
        onMouseDown={(e) =>
          onNodeMouseDown?.(e, node)
        }
      >
        {/* Node Card */}
        <div
          ref={nodeRef}
          onClick={handleCardClick}
          title={
            isReadMode
              ? 'Click to select | Drag to move'
              : 'Click to select | Triple-click (3x) to delete | Drag to move'
          }
          className={`
            relative z-10 px-6 py-3 rounded-xl font-mono text-sm
            tracking-wide select-none cursor-pointer
            shadow-[0_6px_20px_-8px_rgba(0,0,0,0.6)]
            border transition-all duration-150

            ${
              isDragging
                ? `
                  cursor-grabbing
                  scale-[1.02]
                  shadow-[0_12px_32px_rgba(168,85,247,0.45)]
                  ring-2 ring-purple-400/70
                `
                : `
                  cursor-grab
                  hover:scale-[1.01]
                `
            }

            ${
              isNodeSelected
                ? `
                  bg-purple-950/90
                  border-purple-500
                  text-purple-100
                  shadow-[0_0_25px_-4px_rgba(168,85,247,0.65)]
                  ring-2 ring-purple-500/50
                `
                : `
                  bg-zinc-900/95
                  border-zinc-700
                  text-zinc-200
                  hover:border-zinc-500
                  hover:bg-zinc-800
                `
            }
          `}
        >
          {/* Collapse / Expand */}
          {hasChildNodes && (
            <button
              type="button"
              onMouseDown={(e) =>
                e.stopPropagation()
              }
              onClick={handleToggleCollapse}
              className={`
                absolute -top-3.5 -left-3.5
                min-w-[24px] h-6 px-1
                rounded-full
                flex items-center justify-center
                transition-all duration-200
                shadow-xl cursor-pointer z-30
                group/collapse

                ${
                  isCollapsed
                    ? `
                      bg-purple-600
                      border border-purple-400
                      text-white
                      shadow-[0_0_15px_rgba(168,85,247,0.85)]
                      scale-110
                      ring-2 ring-purple-400/40
                      hover:bg-purple-500
                    `
                    : `
                      bg-zinc-900/95
                      border border-zinc-700/90
                      hover:border-purple-400
                      hover:bg-zinc-800
                      text-zinc-400
                      hover:text-purple-300
                    `
                }
              `}
              title={
                isCollapsed
                  ? `Expand ${totalChildCount} hidden child nodes`
                  : `Collapse ${totalChildCount} child nodes`
              }
            >
              {isCollapsed ? (
                <span className="text-[10px] font-bold font-mono tracking-tight flex items-center space-x-0.5 pointer-events-none">
                  <ChevronRight
                    size={11}
                    strokeWidth={3}
                  />
                  <span>
                    {totalChildCount}
                  </span>
                </span>
              ) : (
                <ChevronDown
                  size={12}
                  strokeWidth={2.5}
                  className="
                    group-hover/collapse:scale-110
                    transition-transform
                    pointer-events-none
                  "
                />
              )}
            </button>
          )}

          {/* Node Text */}
          <span className="pointer-events-none select-none font-medium">
            {node.text || 'Untitled'}
          </span>

          {/* Attachment Indicators */}
          {showAnyIndicator && (
            <div
              className="
                absolute -top-7
                left-[calc(100%-10px)]
                flex items-center space-x-1
                bg-zinc-900/95
                p-1 rounded-lg
                border border-zinc-700/80
                shadow-xl z-20
                whitespace-nowrap
              "
              onMouseDown={(e) =>
                e.stopPropagation()
              }
              onClick={(e) =>
                e.stopPropagation()
              }
            >
              {/* Notes */}
              {hasNotes && (
                <button
                  type="button"
                  onClick={handleOpenNotes}
                  className="
                    p-1
                    hover:bg-blue-500/20
                    rounded
                    text-blue-400
                    hover:text-blue-300
                    transition-colors
                    cursor-pointer
                  "
                  title="Open Notes"
                >
                  <FileText size={12} />
                </button>
              )}

              {/* Photos */}
              {hasImages && (
                <button
                  type="button"
                  onClick={handleOpenPhotos}
                  className="
                    p-1
                    hover:bg-purple-500/20
                    rounded
                    text-purple-400
                    hover:text-purple-300
                    transition-colors
                    cursor-pointer
                  "
                  title="Open Photos Preview"
                >
                  <FileImage size={12} />
                </button>
              )}

              {/* Read Mode Media Opener */}
              {showReadModeMediaOpener && (
                <button
                  type="button"
                  onClick={handleOpenPhotos}
                  className="
                    p-1
                    hover:bg-purple-500/25
                    bg-purple-500/10
                    rounded
                    text-purple-400
                    hover:text-purple-200
                    transition-colors
                    cursor-pointer
                    border border-purple-500/30
                  "
                  title="Open Floating Photos Window"
                >
                  <Layers size={12} />
                </button>
              )}
            </div>
          )}

          {/* Create Node Buttons */}
          {!isReadMode && (
            <>
              {/* Right */}
              <button
                type="button"
                onMouseDown={(e) =>
                  e.stopPropagation()
                }
                onClick={handleCreateRight}
                className="
                  absolute -right-3.5
                  top-1/2
                  -translate-y-1/2
                  w-6 h-6
                  rounded-full
                  bg-zinc-900
                  border border-zinc-700/90
                  hover:border-purple-400
                  hover:bg-purple-600
                  text-zinc-400
                  hover:text-white
                  flex items-center justify-center
                  transition-all duration-200
                  shadow-lg
                  hover:shadow-[0_0_12px_rgba(168,85,247,0.7)]
                  cursor-pointer z-30
                  group/btn
                  hover:scale-110
                "
                title="Create connected blank node to the right (→)"
              >
                <Plus
                  size={12}
                  strokeWidth={2.5}
                  className="
                    group-hover/btn:rotate-90
                    transition-transform duration-200
                    pointer-events-none
                  "
                />
              </button>

              {/* Bottom */}
              <button
                type="button"
                onMouseDown={(e) =>
                  e.stopPropagation()
                }
                onClick={handleCreateBottom}
                className="
                  absolute -bottom-3.5
                  left-1/2
                  -translate-x-1/2
                  w-6 h-6
                  rounded-full
                  bg-zinc-900
                  border border-zinc-700/90
                  hover:border-purple-400
                  hover:bg-purple-600
                  text-zinc-400
                  hover:text-white
                  flex items-center justify-center
                  transition-all duration-200
                  shadow-lg
                  hover:shadow-[0_0_12px_rgba(168,85,247,0.7)]
                  cursor-pointer z-30
                  group/btn
                  hover:scale-110
                "
                title="Create connected blank node below (↓)"
              >
                <Plus
                  size={12}
                  strokeWidth={2.5}
                  className="
                    group-hover/btn:rotate-90
                    transition-transform duration-200
                    pointer-events-none
                  "
                />
              </button>
            </>
          )}
        </div>
      </div>
    );
  },
  mindMapNodePropsAreEqual
);

MindMapNode.displayName = 'MindMapNode';

export default MindMapNode;
