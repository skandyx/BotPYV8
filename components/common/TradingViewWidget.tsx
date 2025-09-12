import React, { useEffect, useRef, memo } from 'react';

// Make TradingView available on the window object
declare global {
  interface Window {
    TradingView: any;
  }
}

interface TradingViewWidgetProps {
  symbol: string;
  defaultInterval?: string;
}

const TradingViewWidget: React.FC<TradingViewWidgetProps> = ({ symbol, defaultInterval = "15" }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<any>(null); // To hold the widget instance
  
  // A stable ID is crucial. It only changes when the symbol changes, preventing unnecessary re-renders.
  const containerId = `tradingview_widget_${symbol.replace(/[^a-zA-Z0-9]/g, '')}`;

  useEffect(() => {
    const createWidget = () => {
        if (!containerRef.current || !window.TradingView?.widget) {
            console.error("TradingView script not loaded or container not ready.");
            return;
        }

        // If a widget instance from a previous render/symbol already exists, remove it first.
        // This is the core of the cleanup logic.
        if (widgetRef.current) {
            try {
                widgetRef.current.remove();
            } catch (error) {
                console.warn("Error removing old TradingView widget:", error);
            }
            widgetRef.current = null;
        }
        
        // The container might have leftover elements if remove() fails, so we explicitly clear it.
        containerRef.current.innerHTML = '';

        const widgetOptions = {
            autosize: true,
            symbol: `BINANCE:${symbol}`,
            interval: defaultInterval,
            timezone: "Etc/UTC",
            theme: "dark",
            style: "1",
            locale: "fr",
            toolbar_bg: "#f1f3f6",
            enable_publishing: false,
            hide_side_toolbar: false,
            allow_symbol_change: true,
            container_id: containerId,
            details: true,
            hotlist: true,
            calendar: true,
        };
        
        // Store the new widget instance in the ref for future cleanup.
        widgetRef.current = new window.TradingView.widget(widgetOptions);
    };
    
    // The script is loaded once via index.html. We just need to check if it's available.
    if (window.TradingView && window.TradingView.widget) {
        createWidget();
    } else {
        // If the script is still loading, wait for it.
        const script = document.querySelector('script[src="https://s3.tradingview.com/tv.js"]');
        script?.addEventListener('load', createWidget, { once: true });
    }

    // This cleanup function runs when the component unmounts (e.g., page navigation)
    // or when the dependencies (symbol) change, right before the effect runs again.
    return () => {
        if (widgetRef.current) {
            try {
                widgetRef.current.remove();
            } catch(error) {
                console.warn("Error cleaning up TradingView widget on unmount:", error);
            }
            widgetRef.current = null;
        }
    };
  }, [symbol, defaultInterval, containerId]); // Re-run effect ONLY if the symbol, interval, or stable ID changes.

  return (
    <div 
        id={containerId} 
        ref={containerRef} 
        className="tradingview-widget-container h-[500px]"
    />
  );
};

export default memo(TradingViewWidget);