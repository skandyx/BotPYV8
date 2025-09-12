# BOTPY - Documentation Technique

## 1. Titre & Résumé

**Nom du Projet :** BOTPY

**Résumé :** BOTPY est une plateforme web complète pour le pilotage d'un bot de trading crypto automatisé. Le système opère sur les paires USDT et implémente deux stratégies distinctes : un "Chasseur de Précision Macro-Micro" pour les configurations de marché stables, et une stratégie "Ignition" pour capturer les "pumps" de marché à haute vélocité. La plateforme offre une interface en temps réel, une configuration complète et des modes de trading sécurisés (Virtuel, Papier, Réel).

## 2. Langage & Technologies

### Backend

*   **Langage :** Node.js (JavaScript ES Module)
*   **Base de Données :** SQLite pour la persistance de TOUTES les données (historique et état en temps réel), garantissant des opérations ACID.
*   **Bibliothèques Clés :** `express`, `ws`, `node-fetch`, `sqlite`, `sqlite3`, `technicalindicators`, `express-session`, `dotenv`, `crypto-js`.

### Frontend

*   **Framework :** React 18 avec TypeScript
*   **Outils & Bibliothèques Clés :** `Vite`, `TailwindCSS`, `React Router`, `Recharts`.

## 3. Architecture du Système

Le système est conçu comme un monorepo avec une séparation claire entre le frontend et le backend.

### Modules Principaux

1.  **Backend (`/backend`)** : Le cerveau du bot.
    *   `server.js` : Point d'entrée. Gère le serveur Express (API), le serveur WebSocket, l'authentification et le cycle de vie du bot.
    *   `DatabaseService.js` : Gère toutes les interactions avec la base de données SQLite.
    *   `ScannerService.js` : Module de découverte. Interroge l'API de Binance pour découvrir les paires éligibles.
    *   `TradingStrategy.js` : Cœur de la logique. Contient les stratégies de trading, l'analyse des indicateurs, et la gestion des positions.
    *   `CryptoService.js` : **Nouveau.** Gère le chiffrement et le déchiffrement des clés API.
    *   `RateLimiter.js` : **Nouveau.** Contrôle le flux des requêtes sortantes vers l'API de Binance.
    *   **Persistance** :
        *   **SQLite** : Source de vérité pour TOUT l'état du bot (positions actives, solde, historique des trades, historique des klines).
        *   **Fichiers JSON** : Uniquement pour les configurations et les informations d'authentification.

### Flux de Données

Le backend utilise une approche de cache intelligent. Il consulte d'abord sa base de données SQLite locale pour les données historiques avant de faire appel à l'API de Binance, ce qui réduit la latence et la dépendance à l'API externe. Toutes les requêtes sont passées à travers un rate-limiter pour éviter les sanctions de l'API.

## 4. Stratégies de Trading

Le bot opère avec deux stratégies mutuellement exclusives, sélectionnables dans les paramètres.

### 4.1 Stratégie 1 : "Le Chasseur de Précision Macro-Micro" (Par défaut)
Stratégie conçue pour des conditions de marché saines, filtrant le bruit pour n'agir que sur des configurations à haute probabilité.

### 4.2 Stratégie 2 : "Ignition" 🚀
Stratégie agressive et à haute fréquence, conçue pour détecter et trader les départs de "pumps" violents.

## 5. Sécurité & Robustesse

Des améliorations significatives ont été apportées pour durcir le système.

### 5.1 Chiffrement des Clés API au Repos
*   Les clés API Binance ne sont **jamais stockées en clair**.
*   Elles sont chiffrées (AES) et stockées dans le fichier `.env`.
*   Une `MASTER_ENCRYPTION_KEY`, fournie au démarrage du processus, est utilisée pour déchiffrer les clés en mémoire. Si le serveur est compromis, les clés API restent sécurisées.

### 5.2 Kill-Switch Opérationnel
*   Un paramètre "Mode Lecture Seule" agit comme un **coupe-circuit**.
*   Lorsqu'il est activé, le bot est empêché d'ouvrir toute nouvelle position en mode réel, permettant une intervention d'urgence sans arrêter complètement le service.

### 5.3 Persistance ACID via SQLite
*   L'état critique du bot (solde, positions actives) est désormais stocké dans SQLite.
*   Cela garantit des transactions **ACID (Atomicité, Cohérence, Isolation, Durabilité)**. Il n'y a plus de risque de corruption de l'état si le processus est interrompu pendant une écriture de données, contrairement à la persistance via des fichiers JSON.

### 5.4 Rate-Limiter Interne
*   Pour éviter d'être banni par l'API de Binance pour un trop grand nombre de requêtes (`HTTP 429`), un rate-limiter interne a été implémenté.
*   Il met en file d'attente toutes les requêtes API sortantes et les exécute à un rythme contrôlé, lissant les pics d'activité (notamment au démarrage) et garantissant le respect des limites de l'échange.