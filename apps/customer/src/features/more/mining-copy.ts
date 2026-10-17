import { defineCopy } from '../../shared/i18n';
const en = {
  scope: 'Your workers, shares and mining credits',
  unavailableTitle: 'Mining activity unavailable',
  unavailableBody:
    'This room cannot connect a worker or read your shares and credits. Unavailable records do not mean zero activity or rewards.',
  support: 'Ask about mining access',
  required: 'What this room needs',
  unavailable: 'Unavailable',
  workers: 'Workers',
  workersBody: 'Worker connection, registration, your roster and hashrate are unavailable.',
  shares: 'Accepted shares',
  sharesBody: 'Your accepted-share history cannot be read. No share count is guessed.',
  credits: 'Credits and payouts',
  creditsBody: 'Your mining credits and payout history are unavailable. No reward amount or payout is guessed.',
  publicStatus: 'Public service status',
  readScope:
    'These results only show whether the pool is running. They do not identify your workers or prove accepted shares, credits or a payout.',
  process: 'Pool process',
  responding: 'Responding',
  ledger: 'Ledger connection',
  store: 'Reward window records',
  configured: 'Set up · not tested',
  absent: 'Not set up',
  jobs: 'Registered jobs',
  noJobs: 'No jobs registered',
  refresh: 'Refresh service status',
  boundaries:
    'Connections that are set up have not been tested. A registered job does not prove a successful run or a payment. Nothing can be submitted here until your account is connected to the pool.',
  more: 'Explore More →',
} as const;
const es = {
  scope: 'Tus trabajadores, aportaciones y créditos de minería',
  unavailableTitle: 'La actividad de minería no está disponible',
  unavailableBody:
    'Esta sala no puede conectar un trabajador ni leer tus aportaciones y créditos. Que los registros no estén disponibles no significa que no haya actividad ni recompensas.',
  support: 'Consultar el acceso a minería',
  required: 'Lo que necesita esta sala',
  unavailable: 'No disponible',
  workers: 'Trabajadores',
  workersBody: 'La conexión y el registro de trabajadores, tu lista y la tasa de hash no están disponibles.',
  shares: 'Aportaciones aceptadas',
  sharesBody: 'No se puede leer tu historial de aportaciones aceptadas. No se adivina ningún recuento.',
  credits: 'Créditos y pagos',
  creditsBody: 'Tus créditos de minería y tu historial de pagos no están disponibles. No se adivina ninguna recompensa ni pago.',
  publicStatus: 'Estado público del servicio',
  readScope:
    'Estos resultados solo indican si el pool está en marcha. No identifican tus trabajadores ni prueban aportaciones aceptadas, créditos o pagos.',
  process: 'Proceso del pool',
  responding: 'Responde',
  ledger: 'Conexión con el libro mayor',
  store: 'Registros de ventanas de recompensa',
  configured: 'Configurada · sin probar',
  absent: 'Sin configurar',
  jobs: 'Tareas registradas',
  noJobs: 'No hay tareas registradas',
  refresh: 'Actualizar el estado del servicio',
  boundaries:
    'Las conexiones configuradas no se han probado. Una tarea registrada no prueba una ejecución correcta ni un pago. No se puede enviar nada aquí hasta que tu cuenta esté conectada al pool.',
  more: 'Explorar More →',
} satisfies Record<keyof typeof en, string>;
const fr = {
  scope: 'Tes workers, shares et crédits de minage',
  unavailableTitle: 'L’activité de minage est indisponible',
  unavailableBody:
    'Cette salle ne peut pas connecter de worker ni lire tes shares et crédits. Des dossiers indisponibles ne signifient pas une absence d’activité ou de récompenses.',
  support: 'Consulter l’accès au minage',
  required: 'Ce dont cette salle a besoin',
  unavailable: 'Indisponible',
  workers: 'Workers',
  workersBody: 'La connexion et l’inscription des workers, ta liste et le taux de hachage sont indisponibles.',
  shares: 'Shares acceptées',
  sharesBody: 'Ton historique de shares acceptées ne peut pas être consulté. Aucun nombre de shares n’est deviné.',
  credits: 'Crédits et paiements',
  creditsBody:
    'Tes crédits de minage et ton historique de paiements sont indisponibles. Aucun montant de récompense ni paiement n’est deviné.',
  publicStatus: 'État public du service',
  readScope:
    'Ces résultats indiquent seulement si le pool fonctionne. Ils n’identifient pas tes workers et ne prouvent ni shares acceptées, ni crédits, ni paiement.',
  process: 'Processus du pool',
  responding: 'Répond',
  ledger: 'Connexion au grand livre',
  store: 'Relevés des fenêtres de récompense',
  configured: 'Configurée · non testée',
  absent: 'Non configurée',
  jobs: 'Tâches enregistrées',
  noJobs: 'Aucune tâche enregistrée',
  refresh: 'Actualiser l’état du service',
  boundaries:
    'Les connexions configurées n’ont pas été testées. Une tâche enregistrée ne prouve ni exécution réussie ni paiement. Rien ne peut être soumis ici tant que ton compte n’est pas connecté au pool.',
  more: 'Explorer More →',
} satisfies Record<keyof typeof en, string>;
export const miningCopy = defineCopy('more.mining.availability', en, { es, fr });
