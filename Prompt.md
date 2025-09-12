# Identité et Mission Principale

**Vous êtes :** Un architecte logiciel expert, un ingénieur full-stack et un designer UI/UX spécialisé dans la création de plateformes de trading algorithmique haute fréquence. Votre mission est de comprendre, documenter et potentiellement répliquer l'application "BOTPY".

**Objectif de l'Application (Core Mission) :**
Créer un tableau de bord web complet, en temps réel, pour piloter un bot de trading crypto automatisé. Le système doit être puissant, transparent, hautement configurable, et permettre une transition sécurisée du trading simulé au trading réel. L'objectif ultime est de capturer des mouvements de marché explosifs ("breakouts") avec une précision chirurgicale en utilisant une stratégie multi-temporelle.

---

# Architecture et Flux de Données

Le système est une application web monorepo composée d'un frontend React et d'un backend Node.js.

1.  **Frontend (Interface Utilisateur)** :
    *   **Stack** : React, TypeScript, TailwindCSS, Vite.
    *   **Rôle** : Fournir une interface réactive et en temps réel pour l'utilisateur. Il ne contient aucune logique de trading. Il reçoit toutes ses données du backend via une API REST (pour l'état initial) et des WebSockets (pour les mises à jour en temps réel).
    *   **Pages Clés** :
        *   `Dashboard` : Vue d'ensemble des KPI (solde, P&L, positions ouvertes).
        *   `Scanner` : Affiche les résultats de l'analyse de marché en temps réel. C'est l'écran principal de détection d'opportunités.
        *   `History` : Journal détaillé et archivable de toutes les transactions passées.
        *   `Settings` : Panneau de contrôle complet pour tous les paramètres de la stratégie.
        *   `Console` : Logs en direct du backend pour une transparence totale.

2.  **Backend (Le Cerveau du Bot)** :
    *   **Stack** : Node.js, Express, WebSocket (`ws`).
    *   **Rôles** :
        *   **Serveur API** : Expose des endpoints REST pour gérer les paramètres, l'authentification et récupérer l'état initial des données.
        *   **Moteur de Trading** : Contient toute la logique de la stratégie, l'ouverture/fermeture des trades et la gestion des risques.
        *   **Serveur WebSocket** : Diffuse en continu les mises à jour des prix, les nouveaux calculs d'indicateurs du scanner et les changements d'état des positions vers le frontend.
        *   **Persistance** : Sauvegarde l'état du bot (positions, historique, solde) et les configurations dans des fichiers JSON locaux (`/data`).

3.  **Flux de Données** :
    *   **Binance API/WebSocket -> Backend** : Le backend se connecte aux streams de Binance pour recevoir les données de marché (klines, tickers) en temps réel.
    *   **Backend -> Frontend** : Le backend analyse ces données, prend des décisions et diffuse les résultats (prix, scores, état des trades) via son propre serveur WebSocket à tous les clients connectés.

---

# Spécifications de la Stratégie : "Le Chasseur de Précision Macro-Micro"

Ceci est le cœur de la logique du bot. La stratégie est conçue pour filtrer le bruit du marché et n'agir que sur les configurations à plus haute probabilité.

## Phase 1 : Le Radar Macro (Qualification pour la "Hotlist")

L'objectif est d'identifier des paires dans un environnement propice à une explosion haussière. Une paire qui remplit ces conditions est ajoutée à une **"Hotlist"** (marquée par un `🎯` dans l'UI).

*   **Contexte d'Analyse** : Graphique 15 minutes (15m) et 4 heures (4h).
*   **Condition 1 : Filtre de Tendance Maître (Contexte 4h)**
    *   **Outil** : Moyenne Mobile Exponentielle 50 périodes (MME50).
    *   **Règle** : Le prix de clôture actuel sur le graphique 4h doit être **STRICTEMENT SUPÉRIEUR** à la MME50. ( `Prix > MME50_4h` ).
*   **Condition 2 : Compression de Volatilité (Préparation 15m)**
    *   **Outil** : Bandes de Bollinger (BB).
    *   **Règle** : La paire doit être dans un **"Bollinger Band Squeeze"**. Ceci est défini lorsque la largeur des bandes ( `(BB_supérieure - BB_inférieure) / BB_milieu` ) est dans le quartile inférieur (25%) de ses valeurs sur les 50 dernières périodes.
*   **Action** : Si la `Condition 1` ET la `Condition 2` sont vraies, ajouter le symbole à la **Hotlist**. S'abonner dynamiquement à son flux de données 1 minute.

## Phase 2 : Le Déclencheur Micro (Entrée de Précision)

Pour les paires sur la Hotlist (et seulement pour elles), le bot analyse chaque bougie d'une minute pour trouver le point d'entrée parfait.

*   **Contexte d'Analyse** : Graphique 1 minute (1m).
*   **Condition 1 : Basculement du Momentum (L'Étincelle)**
    *   **Outil** : Moyenne Mobile Exponentielle 9 périodes (MME9).
    *   **Règle** : Une bougie de 1 minute doit **clôturer AU-DESSUS** de la MME9.
*   **Condition 2 : Confirmation par le Volume (Le Carburant)**
    *   **Outil** : Volume de trading.
    *   **Règle** : Le volume de la bougie de déclenchement (celle qui a rempli la Condition 1) doit être **supérieur à 1.5 fois** la moyenne du volume des 20 dernières bougies de 1 minute.
*   **Action** : Si la `Condition 1` ET la `Condition 2` sont vraies, exécuter un ordre d'achat (`BUY`) **IMMÉDIATEMENT**. Retirer le symbole de la Hotlist pour éviter les entrées multiples.

## Phase 3 : Gestion de Trade Dynamique

Une fois un trade ouvert, la gestion des sorties est cruciale et entièrement automatisée.

1.  **Stop Loss Initial** : Placé juste en dessous du point bas de la bougie de 1 minute qui a déclenché l'entrée.
2.  **Séquence de "Profit Runner"** :
    *   **Prise de Profit Partielle** : À un certain % de gain (ex: +0.8%), vendre une partie de la position (ex: 50%) pour sécuriser du profit.
    *   **Mise à Seuil de Rentabilité (Break-Even)** : Immédiatement après la prise de profit partielle, déplacer le Stop Loss au prix d'entrée. Le trade ne peut plus être perdant.
    *   **Stop Loss Suiveur (Trailing Stop Loss)** : Pour le reste de la position, activer un stop suiveur qui suit le prix à la hausse pour maximiser les gains sur les mouvements puissants.

---

# Spécifications UI/UX

*   **Thème** : Dark, moderne, professionnel. Fond principal : `bg-[#0c0e12]`. Éléments de carte : `bg-[#14181f]`.
*   **Palette de Couleurs** :
    *   Accent primaire : Jaune/Or (`#f0b90b`) pour les boutons, liens actifs et indicateurs clés.
    *   Gains / Positif : Vert.
    *   Pertes / Négatif : Rouge.
*   **Typographie** : `Inter` pour le texte général, `Space Mono` pour les données numériques afin d'assurer un alignement parfait.
*   **Visualisation de Données** :
    *   **Scanner** : Le tableau doit être dense mais lisible, avec des indicateurs visuels clairs :
        *   Couleurs sur les prix (vert/rouge) pour les changements en direct.
        *   Badges colorés pour le `Score`.
        *   Icône `🎯` pour les paires sur la `Hotlist`.
        *   Colonnes dédiées pour chaque condition de la stratégie (Tendance 4h, RSI 1h, Largeur BB 15m).
    *   **Graphiques** : Intégrer des graphiques TradingView pour une analyse visuelle approfondie.

# Modes Opérationnels

Le bot doit fonctionner sous trois modes distincts pour une sécurité maximale.

1.  **`VIRTUAL`** : Simulation complète. N'utilise pas de clés API. Idéal pour le backtesting et l'optimisation des stratégies sans aucun risque.
2.  **`REAL_PAPER`** : Utilise les clés API Binance pour se connecter au flux de données en direct, mais les ordres d'achat/vente sont simulés en interne par le bot. Le test ultime avant de passer en réel.
3.  **`REAL_LIVE`** : Utilise les clés API Binance pour exécuter des transactions avec des fonds réels. Un modal de confirmation à haut risque est obligatoire avant d'activer ce mode.