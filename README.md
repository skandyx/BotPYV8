# Trading Bot Dashboard "BOTPY"

BOTPY is a comprehensive web-based dashboard designed to monitor, control, and analyze a multi-pair automated crypto trading bot operating on USDT pairs. It provides a real-time, user-friendly interface to track market opportunities, manage active positions, review performance, and fine-tune the trading strategy. It supports a phased approach to live trading with `Virtual`, `Real (Paper)`, and `Real (Live)` modes.

## ✨ Key Features

-   **Multiple Trading Modes**: A safe, phased approach to live trading.
-   **Dual-Strategy Engine**: Choose between two distinct, powerful trading strategies:
    1.  **"Macro-Micro" Precision Hunter (Default)**: A robust strategy for stable market conditions, combining long-term trend analysis with precision breakout entries.
    2.  **"Ignition" 🚀 (New!)**: An aggressive, high-frequency strategy designed to detect and trade explosive market "pumps" with a unique, ultra-responsive trailing stop loss.
-   **Real-time Market Scanner**: Automatically identifies high-potential trading pairs based on the active strategy's criteria.
-   **Live Dashboard**: Offers an at-a-glance overview of key performance indicators (KPIs).
-   **Detailed Trade History**: Provides a complete log of all past trades with powerful sorting, filtering, and data export (CSV) capabilities.
-   **Fully Configurable**: Every parameter of both strategies is easily adjustable through a dedicated settings page.

---

## 🎨 Application Pages & Design

The application is designed with a dark, modern aesthetic (`bg-[#0c0e12]`), using an `Inter` font for readability and `Space Mono` for numerical data. The primary accent color is a vibrant yellow/gold (`#f0b90b`), used for interactive elements and highlights, with green and red reserved for clear financial indicators.

### 🔐 Login Page
-   **Purpose**: Provides secure access to the dashboard.

### 📊 Dashboard
-   **Purpose**: The main control center, providing a high-level summary of the bot's status and performance.

### 📡 Scanner
-   **Purpose**: To display the real-time results of the market analysis, showing which pairs are potential trade candidates based on the active strategy.

### 📜 History
-   **Purpose**: A dedicated page for reviewing and analyzing the performance of all completed trades.

### ⚙️ Settings
-   **Purpose**: Allows for complete configuration of the bot's operational parameters and the selection and tuning of the active trading strategy.

### 🖥️ Console
-   **Purpose**: Provides a transparent, real-time view into the bot's internal operations with color-coded log levels.

---

## 🧠 Trading Strategies Explained

The bot now features two selectable, mutually exclusive trading strategies.

### 1. "Macro-Micro" Precision Hunter (Default Strategy)

This strategy combines high-level **"Macro"** analysis (4h/15m charts) to find high-probability environments with a low-level **"Micro"** analysis (1m chart) to pinpoint the perfect entry moment.

**Funnel Process:**
1.  **Macro Scan (4h/15m)**: Identifies pairs in a strong uptrend (`Price > EMA50 4h`) that are simultaneously consolidating (`Bollinger Band Squeeze 15m`). Qualified pairs are added to a **"Hotlist"**.
2.  **Micro Trigger (1m)**: For "Hotlist" pairs, it waits for a 1-minute breakout confirmed by momentum (`Close > EMA9`) and volume. Strict safety filters (RSI, Parabolic Move) are applied to prevent bad entries.
3.  **Dynamic Trade Management**: Uses a sophisticated "Profit Runner" sequence involving partial take-profits, moving the stop to break-even, and a percentage-based trailing stop loss to maximize gains.

---

### 2. "Ignition" Strategy 🚀 (New High-Frequency Strategy)

This is an aggressive strategy designed to detect the very beginning of explosive, high-volume price "pumps". It operates entirely on the 1-minute timeframe and bypasses many of the safety checks of the default strategy. **Use with extreme caution.**

**Signal Detection (1m Chart):**
The strategy looks for the simultaneous occurrence of two critical events on a single 1-minute candle:

1.  **🔥 Massive Volume Spike**: The candle's volume must be **X times greater** than the recent average volume (e.g., 5x). This indicates a massive influx of interest.
2.  **🔥 Rapid Price Acceleration**: The price must have increased by **Y percent** over the last **Z minutes** (e.g., +2% in 5 mins). This confirms the volume is translating into a powerful upward move.

If both conditions are met, a `BUY` order is executed instantly.

**Exit Management: "Lightning Trailing Stop Loss" ⚡**
To manage the extreme volatility of pumps, this strategy uses a unique and highly responsive trailing stop loss:
-   The Stop Loss is continuously updated to be placed **just below the low of the *previous* 1-minute candle**.
-   This method is incredibly effective at locking in profits during a vertical price ascent. If the pump stalls or retraces even for a minute, the position is automatically closed, securing the gains. It is designed for rapid entry and rapid exit.

---
# Version Française

## 🧠 Stratégies de Trading Expliquées

Le bot propose désormais deux stratégies de trading sélectionnables et mutuellement exclusives.

### 1. "Le Chasseur de Précision Macro-Micro" (Stratégie par défaut)

Cette stratégie combine une analyse **"Macro"** (graphiques 4h/15m) pour trouver des environnements à forte probabilité avec une analyse **"Micro"** (graphique 1m) pour identifier le point d'entrée parfait.

**Processus en Entonnoir :**
1.  **Scan Macro (4h/15m)** : Identifie les paires dans une forte tendance haussière (`Prix > MME50 4h`) qui sont simultanément en phase de consolidation (`Squeeze des Bandes de Bollinger 15m`). Les paires qualifiées sont ajoutées à une **"Hotlist"**.
2.  **Déclencheur Micro (1m)** : Pour les paires de la "Hotlist", il attend une cassure sur 1 minute confirmée par le momentum (`Clôture > MME9`) et le volume. Des filtres de sécurité stricts (RSI, Mouvement Parabolique) sont appliqués pour éviter les mauvaises entrées.
3.  **Gestion Dynamique du Trade** : Utilise une séquence sophistiquée de prise de profit partielle, de mise au seuil de rentabilité, et un stop loss suiveur basé sur un pourcentage pour maximiser les gains.

---

### 2. Stratégie "Ignition" 🚀 (Nouvelle Stratégie Haute Fréquence)

Ceci est une stratégie agressive conçue pour détecter le tout début des "pumps" de prix explosifs et à fort volume. Elle opère entièrement sur l'échelle de temps de 1 minute et ignore de nombreuses vérifications de sécurité de la stratégie par défaut. **À utiliser avec une extrême prudence.**

**Détection du Signal (Graphique 1m) :**
La stratégie recherche l'apparition simultanée de deux événements critiques sur une seule bougie de 1 minute :

1.  **🔥 Pic de Volume Massif** : Le volume de la bougie doit être **X fois supérieur** au volume moyen récent (ex: 5x). Cela indique un afflux massif d'intérêt.
2.  **🔥 Accélération Foudroyante du Prix** : Le prix doit avoir augmenté de **Y pourcent** au cours des **Z dernières minutes** (ex: +2% en 5 mins). Cela confirme que le volume se traduit par un puissant mouvement haussier.

Si les deux conditions sont remplies, un ordre d'achat (`BUY`) est exécuté instantanément.

**Gestion de Sortie : "Stop Loss Suiveur Éclair" ⚡**
Pour gérer la volatilité extrême des pumps, cette stratégie utilise un stop loss suiveur unique et très réactif :
-   Le Stop Loss est continuellement mis à jour pour être placé **juste en dessous du point bas de la bougie de 1 minute *précédente***.
-   Cette méthode est incroyablement efficace pour verrouiller les profits lors d'une ascension verticale des prix. Si le pump cale ou recule, même pour une minute, la position est automatiquement fermée, sécurisant les gains. Elle est conçue pour une entrée et une sortie rapides.