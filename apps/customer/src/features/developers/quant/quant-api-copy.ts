import { defineCopy } from '../../../shared/i18n';

// /developers/quant (J-algo-dev-14; AL-api-01): Algo dev's strategy API, driven from your own code with an API key. The
// procedures and scopes are svc-quant's (services/svc-quant/src/key-api/key-api.ts); the live stop is svc-trade's
// (services/svc-trade/src/quant/live-run/rest.ts).
export const quantApiCopy = defineCopy(
  'developers-quant',
  {
    lead: 'List your strategies, start a backtest, read its report and stop a live strategy from your own code with an API key.',
    keyTitle: 'Create a key for the strategy API',
    keyBody:
      'Create an API key with only the permissions you need: Strategies and backtests: see (quant:read) to list and read projects and runs, Strategies and backtests: run backtests (quant:run) to start a backtest, and Trading: make changes (trade:write) to stop a live strategy. Each permission is separate, and a key can only access your own account.',
    createKeyLink: 'Create an API key',
    endpointsTitle: 'Endpoints',
    endpointsLead:
      'Include your API key in the Authorization header (Bearer <key>). For strategy and backtest endpoints, pass GET parameters as JSON in the ?input= query string, and send POST parameters as a JSON request body.',
    colMethod: 'Method',
    colPath: 'Path',
    colScope: 'Permission',
    colWhat: 'What it does',
    epList: 'Your saved strategies, newest first; input { limit }',
    epGet: 'One strategy with its versions; input { id }',
    epHistory: 'Your backtest runs, newest first; input { limit }',
    epResult: 'One stored backtest run; input { runId }',
    epReport: 'A run’s report with its metrics and labels; input { runId }',
    epStart: 'Start a backtest of one version; requires an Idempotency-Key header',
    epLiveRuns: 'Your live strategy runs',
    epStop: 'Stop a live run: open orders are cancelled and open positions stay open; repeating the same sequence number changes nothing',
    epLiquidate: 'Liquidate a live run: stop, then submit one reduce-only close per open position',
    pyTitle: 'Python client',
    pyBody:
      'One standalone Python module wraps these endpoints: list and read your projects and runs, start a backtest with your own Idempotency-Key, and stop or liquidate a live run. Refusals raise QuantApiError with the API error code. Decimal values stay strings, and floats in requests are refused. strategy_template() returns a Python strategy that runs in the sandbox. Requires Python 3.11 with no extra packages.',
    pyInstall: 'Save it next to your code as intafaced_quant.py, then: from intafaced_quant import QuantClient, strategy_template',
    pyDownload: 'Download intafaced_quant.py',
    idemTitle: 'One run per Idempotency-Key',
    idemBody:
      'Starting a backtest by API requires an Idempotency-Key header (1 to 128 visible characters, no spaces). Reusing the same key with the same request returns the original run. Reusing it with a different request returns 409 quant.idempotency_key_reused and starts nothing. Omitting the header returns 400 quant.idempotency_key_required.',
    noDeployTitle: 'No deploy by key',
    noDeployBody:
      'There is no endpoint to deploy a strategy with an API key. A strategy goes live only from the app, where you choose its account and sign with your wallet. Calling an unsupported strategy endpoint returns 404 quant.key_no_such_endpoint and stores nothing.',
    rulesTitle: 'Same rules as the app',
    rulesBody:
      'Stopping or liquidating a live run by API follows the same rules and sequence numbers as the Stop and Liquidate buttons in the app and reflects your trading account state. Requests missing the required permission are refused with 403 scope.denied.',
    back: 'All developer docs',
  },
  {
    es: {
      lead: 'Lista tus estrategias, inicia un backtest, lee su informe y detén una estrategia en vivo desde tu propio código con una clave de API.',
      keyTitle: 'Crea una clave para la API de estrategias',
      keyBody:
        'Crea una clave de API solo con los permisos que necesites: Estrategias y backtests: ver (quant:read) para listar y leer proyectos y ejecuciones, Estrategias y backtests: ejecutar backtests (quant:run) para iniciar un backtest, y Trading: hacer cambios (trade:write) para detener una estrategia en vivo. Cada permiso va por separado y la clave solo accede a tu cuenta.',
      createKeyLink: 'Crear una clave de API',
      endpointsTitle: 'Endpoints',
      endpointsLead:
        'Incluye tu clave de API en la cabecera Authorization (Bearer <key>). En los endpoints de estrategias y backtests, pasa los parámetros GET como JSON en ?input= y envía los parámetros POST en el cuerpo JSON.',
      colMethod: 'Método',
      colPath: 'Ruta',
      colScope: 'Permiso',
      colWhat: 'Qué hace',
      epList: 'Tus estrategias guardadas, las más recientes primero; entrada { limit }',
      epGet: 'Una estrategia con sus versiones; entrada { id }',
      epHistory: 'Tus ejecuciones de backtest, las más recientes primero; entrada { limit }',
      epResult: 'Una ejecución de backtest guardada; entrada { runId }',
      epReport: 'El informe de una ejecución con sus métricas y etiquetas; entrada { runId }',
      epStart: 'Inicia un backtest de una versión; requiere la cabecera Idempotency-Key',
      epLiveRuns: 'Tus ejecuciones de estrategias en vivo',
      epStop:
        'Detiene una ejecución en vivo: cancela órdenes abiertas y mantiene posiciones abiertas; repetir el mismo número de secuencia no cambia nada',
      epLiquidate: 'Liquida una ejecución en vivo: detiene y envía un cierre solo-reducción por cada posición abierta',
      pyTitle: 'Cliente de Python',
      pyBody:
        'Un único módulo de Python envuelve estos endpoints: lista y lee tus proyectos y ejecuciones, inicia un backtest con tu Idempotency-Key y detiene o liquida una ejecución en vivo. Los rechazos lanzan QuantApiError con el código de error de la API. Los decimales se envían como texto y se rechazan los flotantes. strategy_template() devuelve una estrategia de ejemplo para el sandbox. Requiere Python 3.11 sin paquetes adicionales.',
      pyInstall: 'Guárdalo junto a tu código como intafaced_quant.py y usa: from intafaced_quant import QuantClient, strategy_template',
      pyDownload: 'Descargar intafaced_quant.py',
      idemTitle: 'Una ejecución por Idempotency-Key',
      idemBody:
        'Iniciar un backtest por API requiere la cabecera Idempotency-Key (de 1 a 128 caracteres visibles, sin espacios). Reutilizar la misma clave con la misma petición devuelve la ejecución original. Reutilizarla con otra petición devuelve 409 quant.idempotency_key_reused y no inicia nada. Sin cabecera devuelve 400 quant.idempotency_key_required.',
      noDeployTitle: 'Sin despliegue por clave',
      noDeployBody:
        'No existe ningún endpoint para desplegar una estrategia con una clave de API. Una estrategia pasa a vivo solo desde la app, donde eliges la cuenta y firmas con tu cartera. Llamar a un endpoint no admitido devuelve 404 quant.key_no_such_endpoint y no guarda nada.',
      rulesTitle: 'Las mismas reglas que en la app',
      rulesBody:
        'Detener o liquidar una ejecución en vivo por API sigue las mismas reglas y números de secuencia que los botones Detener y Liquidar de la app y refleja el estado de tu cuenta de trading. Las peticiones sin el permiso necesario se rechazan con 403 scope.denied.',
      back: 'Toda la documentación para desarrolladores',
    },
    fr: {
      lead: 'Listez vos stratégies, lancez un backtest, consultez son rapport et arrêtez une stratégie en direct depuis votre code avec une clé d’API.',
      keyTitle: 'Créer une clé pour l’API de stratégies',
      keyBody:
        'Créez une clé d’API avec uniquement les autorisations nécessaires : Stratégies et backtests : voir (quant:read) pour lister et lire vos projets et exécutions, Stratégies et backtests : lancer des backtests (quant:run) pour démarrer un backtest, et Trading : agir (trade:write) pour arrêter une stratégie en direct. Chaque autorisation est indépendante et une clé n’accède qu’à votre propre compte.',
      createKeyLink: 'Créer une clé d’API',
      endpointsTitle: 'Endpoints',
      endpointsLead:
        'Ajoutez votre clé d’API dans l’en-tête Authorization (Bearer <key>). Pour les endpoints de stratégies et backtests, transmettez les paramètres GET en JSON via ?input= et envoyez les paramètres POST dans le corps JSON.',
      colMethod: 'Méthode',
      colPath: 'Chemin',
      colScope: 'Autorisation',
      colWhat: 'Action',
      epList: 'Vos stratégies enregistrées, les plus récentes d’abord ; entrée { limit }',
      epGet: 'Une stratégie avec ses versions ; entrée { id }',
      epHistory: 'Vos exécutions de backtest, les plus récentes d’abord ; entrée { limit }',
      epResult: 'Une exécution de backtest enregistrée ; entrée { runId }',
      epReport: 'Le rapport d’une exécution avec ses indicateurs et libellés ; entrée { runId }',
      epStart: 'Lance un backtest d’une version ; nécessite l’en-tête Idempotency-Key',
      epLiveRuns: 'Vos exécutions de stratégies en direct',
      epStop:
        'Arrête une exécution en direct : annule les ordres ouverts et conserve les positions ; répéter le même numéro de séquence ne change rien',
      epLiquidate: 'Liquide une exécution en direct : arrête puis envoie une clôture en réduction seule par position ouverte',
      pyTitle: 'Client Python',
      pyBody:
        'Un seul module Python regroupe ces endpoints : lister et lire vos projets et exécutions, lancer un backtest avec votre Idempotency-Key et arrêter ou liquider une exécution en direct. Les refus lèvent QuantApiError avec le code d’erreur de l’API. Les décimales restent des chaînes et les flottants sont refusés. strategy_template() renvoie un modèle de stratégie pour le bac à sable. Nécessite Python 3.11 sans dépendance externe.',
      pyInstall:
        'Enregistrez-le près de votre code sous intafaced_quant.py, puis : from intafaced_quant import QuantClient, strategy_template',
      pyDownload: 'Télécharger intafaced_quant.py',
      idemTitle: 'Une exécution par Idempotency-Key',
      idemBody:
        'Lancer un backtest par API nécessite un en-tête Idempotency-Key (1 à 128 caractères visibles, sans espace). Réutiliser la même clé avec la même requête renvoie l’exécution initiale. La réutiliser avec une autre requête renvoie 409 quant.idempotency_key_reused sans rien lancer. Sans en-tête, la réponse est 400 quant.idempotency_key_required.',
      noDeployTitle: 'Aucun déploiement par clé',
      noDeployBody:
        'Il n’existe aucun endpoint pour déployer une stratégie avec une clé d’API. Une stratégie passe en direct uniquement depuis l’application, où vous choisissez son compte et signez avec votre portefeuille. Appeler un endpoint non pris en charge renvoie 404 quant.key_no_such_endpoint et n’enregistre rien.',
      rulesTitle: 'Mêmes règles que dans l’application',
      rulesBody:
        'Arrêter ou liquider une exécution en direct par API suit les mêmes règles et numéros de séquence que les boutons Arrêter et Liquider de l’application et reflète l’état de votre compte de trading. Toute requête sans l’autorisation requise est refusée avec 403 scope.denied.',
      back: 'Toute la documentation développeurs',
    },
  },
);
