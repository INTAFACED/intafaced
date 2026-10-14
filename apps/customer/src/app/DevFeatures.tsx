import { features } from './feature-registry';
import { shellCopy } from './shell-copy';

/** `/dev/features` (dev builds only): the registry as a table, so nobody has to read the source to learn what is hidden and why. */
export function DevFeatures() {
  const { t } = shellCopy.useCopy();
  return (
    <section className="tb-dev">
      <h1>{t('Hidden features')}</h1>
      <p>{t('Developer view. Every feature the customer app hides or still has to confirm, with the reason and what unlocks it.')}</p>
      <div className="tb-dev-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">{t('Feature')}</th>
              <th scope="col">{t('Paths')}</th>
              <th scope="col">{t('Status')}</th>
              <th scope="col">{t('Reason')}</th>
              <th scope="col">{t('Unlock')}</th>
              <th scope="col">{t('Checked')}</th>
            </tr>
          </thead>
          <tbody>
            {features.map((feature) => (
              <tr key={feature.id} data-feature={feature.id}>
                <th scope="row">
                  <code>{feature.id}</code>
                  <small>{feature.label}</small>
                </th>
                <td>
                  {[...feature.paths, ...(feature.queries ?? []).map((pair) => `?${pair}`)].map((path) => (
                    <code key={path}>{path}</code>
                  ))}
                </td>
                <td>
                  <span className={`tb-tag tb-tag--${feature.status}`}>{feature.status}</span>
                </td>
                <td>{feature.reason}</td>
                <td>{feature.unlock}</td>
                <td>{feature.checked ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
