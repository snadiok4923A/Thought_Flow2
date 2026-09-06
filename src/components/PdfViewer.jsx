import React, {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { globalPdfCache } from '../utils/pdfCache';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const BASE_RENDER_SCALE = 1.5;

const clamp = (value, min, max) =>
  Math.min(max, Math.max(min, value));

const PdfViewer = memo(({
  url,
  fileId,
  zoom = 1,
  initialViewState = {},
  onSaveViewState,
}) => {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  const pdfDocRef = useRef(null);
  const loadingTaskRef = useRef(null);
  const renderTaskRef = useRef(null);

  const scrollSaveFrameRef = useRef(null);
  const pendingScrollStateRef = useRef(null);

  const restoredForUrlRef = useRef(null);

  const [pdfDoc, setPdfDoc] = useState(null);
  const [currentPage, setCurrentPage] = useState(
    Math.max(1, initialViewState?.page || 1)
  );

  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  /*
   * ------------------------------------------------------------
   * Load PDF
   * ------------------------------------------------------------
   */

  useEffect(() => {
    let cancelled = false;

    const loadPdf = async () => {
      setIsLoading(true);
      setError(null);

      // Reset restoration state for a new PDF.
      restoredForUrlRef.current = null;

      try {
        /*
         * Use existing cache first.
         */
        if (globalPdfCache.has(url)) {
          const cachedDoc = globalPdfCache.get(url);

          if (cancelled) return;

          pdfDocRef.current = cachedDoc;

          setPdfDoc(cachedDoc);
          setTotalPages(cachedDoc.numPages);

          const restoredPage = clamp(
            initialViewState?.page || 1,
            1,
            cachedDoc.numPages
          );

          setCurrentPage(restoredPage);
          setIsLoading(false);

          return;
        }

        /*
         * Load new PDF.
         */
        const loadingTask = pdfjsLib.getDocument(url);

        loadingTaskRef.current = loadingTask;

        const doc = await loadingTask.promise;

        if (cancelled) {
          /*
           * Don't unnecessarily keep a cancelled document.
           */
          return;
        }

        globalPdfCache.set(url, doc);

        pdfDocRef.current = doc;

        setPdfDoc(doc);
        setTotalPages(doc.numPages);

        const restoredPage = clamp(
          initialViewState?.page || 1,
          1,
          doc.numPages
        );

        setCurrentPage(restoredPage);
        setIsLoading(false);
      } catch (err) {
        if (cancelled) return;

        /*
         * Ignore cancellation errors.
         */
        if (
          err?.name === 'AbortException' ||
          err?.name === 'RenderingCancelledException'
        ) {
          return;
        }

        console.error('PDF load error:', err);

        setError('Failed to load PDF preview');
        setIsLoading(false);
      }
    };

    loadPdf();

    return () => {
      cancelled = true;

      /*
       * Cancel loading if still in progress.
       */
      try {
        loadingTaskRef.current?.destroy?.();
      } catch {
        // Ignore cleanup errors.
      }

      loadingTaskRef.current = null;
    };
  }, [url, initialViewState?.page]);

  /*
   * ------------------------------------------------------------
   * Render current page
   * ------------------------------------------------------------
   */

  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) {
      return;
    }

    let cancelled = false;

    const renderPage = async () => {
      try {
        /*
         * Cancel previous render.
         */
        if (renderTaskRef.current) {
          try {
            renderTaskRef.current.cancel();
          } catch {
            // Ignore cancellation errors.
          }

          renderTaskRef.current = null;
        }

        const page = await pdfDoc.getPage(currentPage);

        if (cancelled || !canvasRef.current) {
          return;
        }

        const canvas = canvasRef.current;
        const context = canvas.getContext('2d', {
          alpha: false,
          desynchronized: true,
        });

        /*
         * Render resolution.
         *
         * We don't render at an enormous scale.
         * CSS zoom handles the visual scaling.
         *
         * This keeps page changes much faster.
         */
        const renderScale =
          BASE_RENDER_SCALE *
          clamp(zoom, MIN_ZOOM, MAX_ZOOM);

        const viewport = page.getViewport({
          scale: renderScale,
        });

        /*
         * High-DPI support.
         */
        const devicePixelRatio =
          Math.min(window.devicePixelRatio || 1, 2);

        canvas.width =
          Math.ceil(viewport.width * devicePixelRatio);

        canvas.height =
          Math.ceil(viewport.height * devicePixelRatio);

        /*
         * CSS dimensions represent logical size.
         */
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        /*
         * Reset transform before rendering.
         */
        context.setTransform(
          devicePixelRatio,
          0,
          0,
          devicePixelRatio,
          0,
          0
        );

        context.imageSmoothingEnabled = true;

        const renderTask = page.render({
          canvasContext: context,
          viewport,
        });

        renderTaskRef.current = renderTask;

        await renderTask.promise;

        if (cancelled) return;

        /*
         * Restore scroll exactly once for this PDF.
         */
        if (
          restoredForUrlRef.current !== url &&
          containerRef.current
        ) {
          const container = containerRef.current;

          requestAnimationFrame(() => {
            if (!container) return;

            if (
              typeof initialViewState?.pdfScrollTop ===
              'number'
            ) {
              container.scrollTop =
                initialViewState.pdfScrollTop;
            }

            if (
              typeof initialViewState?.pdfScrollLeft ===
              'number'
            ) {
              container.scrollLeft =
                initialViewState.pdfScrollLeft;
            }
          });

          restoredForUrlRef.current = url;
        }
      } catch (err) {
        if (cancelled) return;

        if (
          err?.name !== 'RenderingCancelledException'
        ) {
          console.error(
            'PDF render error:',
            err
          );
        }
      }
    };

    renderPage();

    return () => {
      cancelled = true;

      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch {
          // Ignore cleanup errors.
        }

        renderTaskRef.current = null;
      }
    };
  }, [
    pdfDoc,
    currentPage,
    url,
    zoom,
    initialViewState?.pdfScrollTop,
    initialViewState?.pdfScrollLeft,
  ]);

  /*
   * ------------------------------------------------------------
   * Save scroll position
   * ------------------------------------------------------------
   *
   * IMPORTANT:
   * Don't save on every scroll event.
   *
   * requestAnimationFrame limits writes to roughly
   * one per browser frame.
   */

  const saveScrollState = useCallback(() => {
    if (
      !onSaveViewState ||
      !fileId ||
      !pendingScrollStateRef.current
    ) {
      return;
    }

    const state = pendingScrollStateRef.current;

    onSaveViewState(fileId, state);

    pendingScrollStateRef.current = null;
    scrollSaveFrameRef.current = null;
  }, [fileId, onSaveViewState]);

  const handleScroll = useCallback((e) => {
    if (!onSaveViewState || !fileId) {
      return;
    }

    const element = e.currentTarget;

    pendingScrollStateRef.current = {
      pdfScrollTop: element.scrollTop,
      pdfScrollLeft: element.scrollLeft,
    };

    if (!scrollSaveFrameRef.current) {
      scrollSaveFrameRef.current =
        requestAnimationFrame(saveScrollState);
    }
  }, [
    fileId,
    onSaveViewState,
    saveScrollState,
  ]);

  /*
   * ------------------------------------------------------------
   * Page navigation
   * ------------------------------------------------------------
   */

  const handlePageChange = useCallback(
    (newPage) => {
      const page = clamp(
        newPage,
        1,
        totalPages
      );

      if (page === currentPage) {
        return;
      }

      /*
       * Immediately reset scroll.
       *
       * This prevents the new page from inheriting
       * the previous page's position.
       */
      if (containerRef.current) {
        containerRef.current.scrollTop = 0;
        containerRef.current.scrollLeft = 0;
      }

      setCurrentPage(page);

      if (onSaveViewState && fileId) {
        onSaveViewState(fileId, {
          page,
          pdfScrollTop: 0,
          pdfScrollLeft: 0,
        });
      }
    },
    [
      currentPage,
      totalPages,
      fileId,
      onSaveViewState,
    ]
  );

  /*
   * ------------------------------------------------------------
   * Cleanup pending RAF
   * ------------------------------------------------------------
   */

  useEffect(() => {
    return () => {
      if (scrollSaveFrameRef.current) {
        cancelAnimationFrame(
          scrollSaveFrameRef.current
        );
      }
    };
  }, []);

  /*
   * ------------------------------------------------------------
   * Error state
   * ------------------------------------------------------------
   */

  if (error) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center p-4 text-center">
        <object
          data={`${url}#toolbar=0&navpanes=0&scrollbar=0`}
          type="application/pdf"
          className="w-full h-full rounded-xl border border-zinc-800"
        >
          <p className="text-zinc-400 text-xs">
            PDF preview not supported directly in
            this browser view.
          </p>
        </object>
      </div>
    );
  }

  /*
   * ------------------------------------------------------------
   * UI
   * ------------------------------------------------------------
   */

  return (
    <div
      className="
        w-full h-full
        flex flex-col
        items-center
        relative
        overflow-hidden
        bg-zinc-950
      "
    >
      {isLoading ? (
        <div
          className="
            flex-1
            flex flex-col
            items-center justify-center
            text-zinc-400
            space-y-2
          "
        >
          <div
            className="
              w-6 h-6
              border-2
              border-purple-500
              border-t-transparent
              rounded-full
              animate-spin
            "
          />

          <span className="text-xs">
            Rendering PDF...
          </span>
        </div>
      ) : (
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="
            flex-1
            w-full
            min-h-0
            overflow-auto
            flex
            items-center
            justify-center
            p-3
            overscroll-contain
          "
        >
          <div
            className="
              flex
              items-center
              justify-center
              flex-shrink-0
              min-w-fit
              min-h-fit
            "
          >
            <canvas
              ref={canvasRef}
              className="
                rounded-lg
                shadow-2xl
                bg-white
                block
                max-w-none
                select-none
              "
            />
          </div>
        </div>
      )}

      {totalPages > 1 && (
        <div
          className="
            flex items-center
            space-x-2
            py-1 px-3
            bg-zinc-900/95
            border border-zinc-800
            rounded-full
            text-xs
            text-zinc-300
            shadow-xl
            flex-none
            my-1
            z-10
            backdrop-blur-md
          "
        >
          <button
            type="button"
            disabled={currentPage <= 1}
            onClick={() =>
              handlePageChange(
                currentPage - 1
              )
            }
            className="
              px-1.5 py-0.5
              rounded
              hover:bg-zinc-800
              disabled:opacity-30
              cursor-pointer
            "
            aria-label="Previous page"
          >
            ‹
          </button>

          <span className="font-mono text-[11px]">
            Page {currentPage} / {totalPages}
          </span>

          <button
            type="button"
            disabled={
              currentPage >= totalPages
            }
            onClick={() =>
              handlePageChange(
                currentPage + 1
              )
            }
            className="
              px-1.5 py-0.5
              rounded
              hover:bg-zinc-800
              disabled:opacity-30
              cursor-pointer
            "
            aria-label="Next page"
          >
            ›
          </button>
        </div>
      )}
    </div>
  );
});

PdfViewer.displayName = 'PdfViewer';

export default PdfViewer;
