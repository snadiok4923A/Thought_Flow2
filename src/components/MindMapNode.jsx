import React, { useLayoutEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, FileImage, FileText, Layers, Plus } from 'lucide-react';
import { hasTextContent } from '../utils/treeUtils';
const mindMapNodePropsAreEqual = (prevProps, nextProps) => {
  if (
    prevProps.activeNodeId !== nextProps.activeNodeId ||
    prevProps.isSelected !== nextProps.isSelected ||
    prevProps.isDragging !== nextProps.isDragging ||
    prevProps.isCollapsed !== nextProps.isCollapsed ||
    prevProps.isReadMode !== nextProps.isReadMode ||
    prevProps.isFloatingMediaOpen !== nextProps.isFloatingMediaOpen ||
    prevProps.dragOffset?.dx !== nextProps.dragOffset?.dx ||
    prevProps.dragOffset?.dy !== nextProps.dragOffset?.dy
  ) {
    return false;
  }
  const pNode = prevProps.node;
  const nNode = nextProps.node;
  if (
    pNode.id !== nNode.id ||
    pNode.text !== nNode.text ||
    pNode.x !== nNode.x ||
    pNode.y !== nNode.y ||
    pNode.notes !== nNode.notes
  ) {
    return false;
  }
  const pRightCount = pNode.rightChildren?.length || 0;
  const nRightCount = nNode.rightChildren?.length || 0;
  if (pRightCount !== nRightCount) return false;

  const pBottomCount = pNode.children?.length || 0;
  const nBottomCount = nNode.children?.length || 0;
  if (pBottomCount !== nBottomCount) return false;
  
  const pImageCount = pNode.images?.length || 0;
  const nImageCount = nNode.images?.length || 0;
  if (pImageCount !== nImageCount) return false;

  return true;
};

const MindMapNode = React.memo(({ 
  node, 
  activeNodeId, 
  isSelected = false,
  isDragging,
  dragOffset = null,
  isCollapsed,
  onToggleCollapse,
  onNodeMouseDown,
  onNodeClick,
  onDeleteNode,
  onOpenMediaTab, 
  isReadMode, 
  isFloatingMediaOpen,
  onCreateNodeInDirection,
  onMeasureDimensions 
}) => {
  const nodeRef = useRef(null);
  const clickTrackerRef = useRef({ count: 0, lastTime: 0 });
  const isNodeSelected = isSelected || node.id === activeNodeId;
  const hasNotes = hasTextContent(node.notes);
  const hasImages = node.images && node.images.length > 0;
  const hasMedia = hasImages;

  const rightCount = node.rightChildren?.length || 0;
  const bottomCount = node.children?.length || 0;
  const totalChildCount = rightCount + bottomCount;
  const hasChildNodes = totalChildCount > 0;

  // In Read Mode, if floating window is closed and no photo exists yet, show the floating media opener icon
  const showReadModeMediaOpener = isReadMode && !isFloatingMediaOpen && !hasMedia;
  const showAnyIndicator = hasNotes || hasImages || showReadModeMediaOpener;
  
  useLayoutEffect(() => {
    if (nodeRef.current && onMeasureDimensions) {
      // Use offsetWidth / offsetHeight so dimensions are purely unscaled world coordinates
      const el = nodeRef.current;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w > 0 && h > 0) {
        onMeasureDimensions(node.id, w, h);
      }
    }
  }, [node.id, node.text, totalChildCount, isCollapsed, showAnyIndicator, onMeasureDimensions]);

  const handleCardClick = (e) => {
    if (e.target.closest('button, [title*="Open"], [title*="Create"], [title*="Collapse"], [title*="Expand"]')) {
      return;
    }
    e.stopPropagation();

    const now = Date.now();
    if (now - clickTrackerRef.current.lastTime < 500) {
      clickTrackerRef.current.count += 1;
    } else {
      clickTrackerRef.current.count = 1;
    }
    clickTrackerRef.current.lastTime = now;

    // Triple Click: delete this node! (Disabled in Read Mode)
    if (clickTrackerRef.current.count >= 3 || e.detail >= 3) {
      clickTrackerRef.current.count = 0;
      if (isReadMode) {
        // Ignore triple-click delete in Read Mode
        if (onNodeClick) {
          onNodeClick(node, e);
        }
        return;
      }
      if (onDeleteNode) {
        onDeleteNode(node.id);
      }
      return;
    }

    if (onNodeClick) {
      onNodeClick(node, e);
    }
  };

  const xPos = typeof node.x === 'number' ? node.x : 650;
  const yPos = typeof node.y === 'number' ? node.y : 260;

  return (
    <div 
      id={`node-${node.id}`} 
      data-node-id={node.id}
      style={{
        position: 'absolute',
        left: `${xPos}px`,
        top: `${yPos}px`,
        transform: dragOffset ? `translate(${dragOffset.dx}px, ${dragOffset.dy}px)` : 'none',
        zIndex: isDragging ? 40 : (isNodeSelected ? 30 : 10)
      }}
      className="mind-map-node select-none inline-flex flex-col items-center group/node"
      onMouseDown={(e) => onNodeMouseDown && onNodeMouseDown(e, node)}
    >
      {/* Node Card Box */}
      <div 
        ref={nodeRef}
        onClick={handleCardClick}
        title={isReadMode ? "Click to select | Drag to move" : "Click to select | Triple-click (3x) to delete | Drag to move"}
        className={`
          relative z-10 px-6 py-3 rounded-xl font-mono text-sm tracking-wide select-none cursor-pointer
          shadow-[0_6px_20px_-8px_rgba(0,0,0,0.6)] border transition-all duration-150
          ${isDragging ? 'cursor-grabbing scale-[1.02] shadow-[0_12px_32px_rgba(168,85,247,0.45)] ring-2 ring-purple-400/70' : 'cursor-grab hover:scale-[1.01]'}
          ${isNodeSelected
            ? 'bg-purple-950/90 border-purple-500 text-purple-100 shadow-[0_0_25px_-4px_rgba(168,85,247,0.65)] ring-2 ring-purple-500/50' 
            : 'bg-zinc-900/95 border-zinc-700 text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800'
          }
        `}
      >
        {/* Collapse / Expand Toggle Button (appears ONLY when the node has child nodes) */}
        {hasChildNodes && (
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (onToggleCollapse) onToggleCollapse(node.id);
            }}
            className={`
              absolute -top-3.5 -left-3.5 min-w-[24px] h-6 px-1 rounded-full flex items-center justify-center transition-all duration-200 shadow-xl cursor-pointer z-30 group/collapse
              ${isCollapsed 
                ? 'bg-purple-600 border border-purple-400 text-white shadow-[0_0_15px_rgba(168,85,247,0.85)] scale-110 ring-2 ring-purple-400/40 hover:bg-purple-500' 
                : 'bg-zinc-900/95 border border-zinc-700/90 hover:border-purple-400 hover:bg-zinc-800 text-zinc-400 hover:text-purple-300'
              }
            `}
            title={isCollapsed ? `Expand ${totalChildCount} hidden child nodes` : `Collapse ${totalChildCount} child nodes`}
          >
            {isCollapsed ? (
              <span className="text-[10px] font-bold font-mono tracking-tight flex items-center space-x-0.5 pointer-events-none">
                <ChevronRight size={11} strokeWidth={3} />
                <span>{totalChildCount}</span>
              </span>
            ) : (
              <ChevronDown size={12} strokeWidth={2.5} className="group-hover/collapse:scale-110 transition-transform pointer-events-none" />
            )}
          </button>
        )}

        <span className="pointer-events-none select-none font-medium">
          {node.text || 'Untitled'}
        </span>
        
        {/* Interactive Indicators / Badges for attachments (elevated above the top-right corner with a clear gap from the right "+" button) */}
        {showAnyIndicator && (
          <div 
            className="absolute -top-7 left-[calc(100%-10px)] flex items-center space-x-1 bg-zinc-900/95 p-1 rounded-lg border border-zinc-700/80 shadow-xl z-20 whitespace-nowrap"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {hasNotes && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (onOpenMediaTab) onOpenMediaTab(node, 'notes');
                  else onNodeClick(node);
                }}
                className="p-1 hover:bg-blue-500/20 rounded text-blue-400 hover:text-blue-300 transition-colors cursor-pointer"
                title="Open Notes"
              >
                <FileText size={12} />
              </button>
            )}
            {hasImages && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (onOpenMediaTab) onOpenMediaTab(node, 'photos');
                  else onNodeClick(node);
                }}
                className="p-1 hover:bg-purple-500/20 rounded text-purple-400 hover:text-purple-300 transition-colors cursor-pointer"
                title="Open Photos Preview"
              >
                <FileImage size={12} />
              </button>
            )}

            {/* Special Floating Media Opener icon in Read Mode */}
            {showReadModeMediaOpener && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (onOpenMediaTab) onOpenMediaTab(node, 'photos');
                  else onNodeClick(node);
                }}
                className="p-1 hover:bg-purple-500/25 bg-purple-500/10 rounded text-purple-400 hover:text-purple-200 transition-colors cursor-pointer border border-purple-500/30"
                title="Open Floating Photos Window"
              >
                <Layers size={12} />
              </button>
            )}
          </div>
        )}

        {/* Right & Bottom "+" Buttons (Normal Mode Only; completely hidden in Read Mode) */}
        {!isReadMode && (
          <>
            {/* Right "+" Button: Add connected blank node on the right */}
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (onCreateNodeInDirection) onCreateNodeInDirection(node, 'right');
              }}
              className="absolute -right-3.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-zinc-900 border border-zinc-700/90 hover:border-purple-400 hover:bg-purple-600 text-zinc-400 hover:text-white flex items-center justify-center transition-all duration-200 shadow-lg hover:shadow-[0_0_12px_rgba(168,85,247,0.7)] cursor-pointer z-30 group/btn hover:scale-110"
              title="Create connected blank node to the right (→)"
            >
              <Plus size={12} strokeWidth={2.5} className="group-hover/btn:rotate-90 transition-transform duration-200 pointer-events-none" />
            </button>

            {/* Bottom "+" Button: Add connected blank node below */}
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (onCreateNodeInDirection) onCreateNodeInDirection(node, 'bottom');
              }}
              className="absolute -bottom-3.5 left-1/2 -translate-x-1/2 w-6 h-6 rounded-full bg-zinc-900 border border-zinc-700/90 hover:border-purple-400 hover:bg-purple-600 text-zinc-400 hover:text-white flex items-center justify-center transition-all duration-200 shadow-lg hover:shadow-[0_0_12px_rgba(168,85,247,0.7)] cursor-pointer z-30 group/btn hover:scale-110"
              title="Create connected blank node below (↓)"
            >
              <Plus size={12} strokeWidth={2.5} className="group-hover/btn:rotate-90 transition-transform duration-200 pointer-events-none" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}, mindMapNodePropsAreEqual);



export default MindMapNode;