import { ChartBox, ChartCanvas } from '@intafaced/ui/lit/templates';

/**
 * A stand-in for a charting library: it is handed the drawing element, reads the size the box gave it, and draws a
 * TEST line across a canvas of that size in the element's own text colour (a role token, through the kit's CSS).
 */
function drawInto(host: HTMLDivElement | null) {
  if (!host || host.querySelector('canvas')) return;
  const canvas = document.createElement('canvas');
  canvas.width = host.clientWidth;
  canvas.height = host.clientHeight;
  host.dataset.size = `${canvas.width}x${canvas.height}`;
  host.append(canvas);
  const pen = canvas.getContext('2d');
  if (!pen) return;
  pen.strokeStyle = getComputedStyle(host).color;
  pen.lineWidth = 2;
  pen.beginPath();
  pen.moveTo(0, canvas.height * 0.7);
  pen.lineTo(canvas.width * 0.4, canvas.height * 0.4);
  pen.lineTo(canvas.width, canvas.height * 0.2);
  pen.stroke();
}

/** The kit's sized chart box: a library's drawing filling it, and a state in its place at the same size. */
export function ChartBoxes() {
  return (
    <div className="vk-grid">
      <ChartBox marks={{ 'data-testid': 'kit-chart-box' }}>
        <ChartCanvas
          label="TEST price, drawn by a charting library into the box"
          host={drawInto}
          hostMarks={{ 'data-testid': 'kit-chart-host' }}
        />
      </ChartBox>
      <ChartBox>
        <p className="vk-type__micro" role="status">
          No trades yet, TEST: the state takes the chart’s place at the same size.
        </p>
      </ChartBox>
    </div>
  );
}
