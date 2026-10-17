import { defineCopy } from '../../shared/i18n';
const en = {
  scope: 'Your workers, shares and mining credits',
  unavailableTitle: 'Pool status',
  unavailableBody:
    'This tab shows whether the pool is running. Your workers, shares and credits are in their own tabs, and each one says so plainly when it can’t be read.',
  support: 'Ask about mining access',
  required: 'Where your records are',
  unavailable: 'Read-only',
  workers: 'Workers',
  workersBody: 'The workers the pool lists for you, with their accepted share weight. Registering a worker isn’t open to customers yet.',
  shares: 'Accepted shares',
  sharesBody: 'Your accepted and rejected shares and their weight, by payout window.',
  credits: 'Credits and payouts',
  creditsBody: 'Estimates for open windows and the credits already paid to you.',
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
    'Connections that are set up have not been tested. A registered job does not prove a successful run or a payment. Nothing is submitted from this room.',
  more: 'Explore More →',
} as const;
const es = {
  scope: 'Tus trabajadores, aportaciones y créditos de minería',
  unavailableTitle: 'Estado del pool',
  unavailableBody:
    'Esta pestaña muestra si el pool está en marcha. Tus trabajadores, aportaciones y créditos están en sus propias pestañas, y cada una lo dice claramente cuando no se puede leer.',
  support: 'Consultar el acceso a minería',
  required: 'Dónde están tus registros',
  unavailable: 'Solo lectura',
  workers: 'Trabajadores',
  workersBody:
    'Los trabajadores que el pool lista para ti, con el peso de sus aportaciones aceptadas. Registrar un trabajador aún no está abierto a los clientes.',
  shares: 'Aportaciones aceptadas',
  sharesBody: 'Tus aportaciones aceptadas y rechazadas y su peso, por ventana de pago.',
  credits: 'Créditos y pagos',
  creditsBody: 'Estimaciones de las ventanas abiertas y los créditos que ya se te han pagado.',
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
    'Las conexiones configuradas no se han probado. Una tarea registrada no prueba una ejecución correcta ni un pago. Desde esta sala no se envía nada.',
  more: 'Explorar More →',
} satisfies Record<keyof typeof en, string>;
const fr = {
  scope: 'Tes workers, shares et crédits de minage',
  unavailableTitle: 'État du pool',
  unavailableBody:
    'Cet onglet indique si le pool fonctionne. Tes workers, shares et crédits sont dans leurs propres onglets, et chacun le dit clairement quand il ne peut pas être lu.',
  support: 'Consulter l’accès au minage',
  required: 'Où se trouvent tes relevés',
  unavailable: 'Lecture seule',
  workers: 'Workers',
  workersBody:
    'Les workers que le pool liste pour toi, avec le poids de leurs shares acceptées. L’enregistrement d’un worker n’est pas encore ouvert aux clients.',
  shares: 'Shares acceptées',
  sharesBody: 'Tes shares acceptées et refusées et leur poids, par fenêtre de paiement.',
  credits: 'Crédits et paiements',
  creditsBody: 'Les estimations des fenêtres ouvertes et les crédits qui t’ont déjà été versés.',
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
    'Les connexions configurées n’ont pas été testées. Une tâche enregistrée ne prouve ni exécution réussie ni paiement. Rien n’est envoyé depuis cette salle.',
  more: 'Explorer More →',
} satisfies Record<keyof typeof en, string>;
export const miningCopy = defineCopy('more.mining.availability', en, { es, fr });
