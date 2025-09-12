# BOTPY - Documentation Technique

## 1. Titre & Résumé

**Nom du Projet :** BOTPY

**Résumé :** BOTPY est une plateforme web complète pour le pilotage d'un bot de trading crypto automatisé. Le système opère sur les paires USDT et implémente deux stratégies distinctes : un "Chasseur de Précision Macro-Micro" pour les configurations de marché stables, et une stratégie "Ignition" pour capturer les "pumps" de marché à haute vélocité. La plateforme offre une interface en temps réel, une configuration complète et des modes de trading sécurisés (Virtuel, Papier, Réel).

## 2. Langage & Technologies

### Backend

*   **Langage :** Node.js (JavaScript ES Module)
*   **Base de Données :** SQLite pour la persistance de TOUTES les données historiques (klines et historique des transactions).
*   **Bibliothèques Clés :** `express`, `ws`, `node-fetch`, `sqlite`, `sqlite3`, `technicalindicators`, `express-session`, `dotenv`.

### Frontend

*   **Framework :** React 18 avec TypeScript
*   **Outils & Bibliothèques Clés :** `Vite`, `TailwindCSS`, `React Router`, `Recharts`.

## 3. Architecture du Système

Le système est conçu comme un monorepo avec une séparation claire entre le frontend et le backend.

### Modules Principaux

1.  **Backend (`/backend`)** : Le cerveau du bot.
    *   `server.js` : Point d'entrée. Gère le serveur Express (API), le serveur WebSocket, l'authentification et le cycle de vie du bot.
    *   `DatabaseService.js` : **Nouveau.** Gère toutes les interactions avec la base de données SQLite pour stocker et récupérer les données de bougies (klines) et l'historique des transactions.
    *   `ScannerService.js` : Module de découverte. Interroge périodiquement l'API de Binance pour découvrir les paires éligibles (volume, etc.).
    *   `TradingStrategy.js` : **Cœur de la logique.** Contient les stratégies de trading, l'analyse des indicateurs en temps réel (alimentée par le `DatabaseService`), et la gestion des positions.
    *   **Persistance (`/backend/data`)** :
        *   Fichiers JSON pour l'état en temps réel du bot (positions actives, solde), les configurations et l'authentification.
        *   Fichier `klines.sqlite` pour tout l'historique (données de marché et transactions).

### Flux de Données

Le backend utilise maintenant une approche de cache intelligent. Il consulte d'abord sa base de données SQLite locale pour les données historiques avant de faire appel à l'API de Binance, ce qui réduit la latence et la dépendance à l'API externe.

### Schéma d'Architecture (Mermaid)

```mermaid
graph TD
    subgraph "Échange (Binance)"
        B_API[API REST]
        B_WS[Flux WebSocket]
    end

    subgraph "Backend (Serveur Node.js)"
        API[Serveur API Express]
        WS_Server[Serveur WebSocket]
        Scanner[ScannerService]
        Strategy[TradingStrategy.js]
        DB[DatabaseService SQLite]
        Persistence[Persistance (JSON)]
    end

    subgraph "Frontend (Navigateur)"
        UI[Interface React]
    end

    B_API -- Données Tickers 24h --> Scanner
    B_API -- Klines manquantes --> Strategy
    B_WS -- Klines & Tickers temps réel --> Strategy

    Scanner -- Paires éligibles --> server.js
    Strategy -- Sauvegarde nouvelles klines & trades --> DB
    Strategy -- Lit klines pour analyse --> DB
    Strategy -- Met à jour l'état --> Persistence
    Strategy -- Décisions/Indicateurs --> WS_Server
    
    API -- Données initiales & Actions --> UI
    Persistence -- Charge/Sauvegarde l'état --> API
    DB -- Charge l'historique --> API
    
    UI -- Connexion WebSocket --> WS_Server
    WS_Server -- Mises à jour en temps réel --> UI
```

## 4. Stratégies de Trading

Le bot opère avec deux stratégies mutuellement exclusives, sélectionnables dans les paramètres.

### 4.1 Stratégie 1 : "Le Chasseur de Précision Macro-Micro" (Par défaut)

C'est une stratégie conçue pour des conditions de marché saines, filtrant le bruit pour n'agir que sur des configurations à haute probabilité.

#### Phase 1 : Scan Macro & Qualification sur la "Hotlist" (4h / 15m)
1.  **✅ Filtre de Tendance Maître (4h)** : `Prix > MME50`.
2.  **✅ Compression de Volatilité (15m)** : Détection d'un "Bollinger Band Squeeze" sur la bougie *précédente*.

#### Phase 2 : Déclencheur Micro & Vérifications de Sécurité (1m)
1.  **✅ Changement de Momentum** : Clôture 1m > MME9.
2.  **✅ Confirmation par le Volume** : Volume 1m > 1.5x la moyenne des 20 dernières.
3.  **⚠️ Filtres de Sécurité** : Vérification du RSI (< seuil) et du mouvement parabolique.

#### Phase 3 : Gestion de Trade Dynamique ("Profit Runner")
Utilise une séquence de prise de profit partielle, de mise à seuil de rentabilité et de stop loss suiveur pour maximiser les gains.

---

### 4.2 Stratégie 2 : "Ignition" 🚀

C'est une stratégie agressive et à haute fréquence, conçue pour détecter et trader les départs de "pumps" violents.

#### Phase 1 : Détection du Signal (1m)
1.  **🔥 Pic de Volume Massif** : Volume 1m > X fois la moyenne (configurable).
2.  **🔥 Accélération Foudroyante du Prix** : Prix augmente de Y% sur Z minutes (configurable).

#### Phase 2 : Gestion de Trade "Stop Loss Suiveur Éclair" ⚡
Le stop loss est constamment déplacé juste en dessous du point bas de la bougie de 1 minute *précédente*, permettant de sécuriser les gains de manière très agressive.

## 5. Historisation & Base de Données

Le système utilise une double approche pour la persistance :
1.  **Fichiers JSON (`/data`)**: Pour l'état **en temps réel** et transactionnel du bot (positions actives, solde) et les configurations. C'est simple et efficace pour l'état global.
2.  **Base de Données SQLite (`/data/klines.sqlite`)**: Pour stocker **TOUT l'historique** des données (bougies/klines et historique des transactions). Cela offre des performances de lecture/écriture rapides, une meilleure intégrité des données et réduit la dépendance à l'API de Binance. Le système gère automatiquement la taille de la base de données en élaguant les enregistrements les plus anciens.

## 6. Déploiement & Maintenance

Les instructions de déploiement sont disponibles dans `INSTALL.md`. Notez qu'il peut être nécessaire d'installer des outils de compilation sur le serveur pour la dépendance `sqlite3`.

## 7. Sécurité & Bonnes Pratiques

Les pratiques de sécurité sont maintenues. L'ajout d'un cache de données local renforce la résilience du bot en cas de problèmes de connectivité avec l'API de Binance.
