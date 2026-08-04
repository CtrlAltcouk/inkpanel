// Replaced in Task 10. Renders the plain coordinate fields so the panels tab
// is usable and testable before the picker exists.
import { esc } from './components.js';

export function renderCityPicker(container, device) {
  container.innerHTML = `
    <div class="row">
      <div>
        <label for="lat">Latitude</label>
        <input id="lat" name="latitude" type="number" step="any" value="${esc(device.latitude)}">
      </div>
      <div>
        <label for="lon">Longitude</label>
        <input id="lon" name="longitude" type="number" step="any" value="${esc(device.longitude)}">
      </div>
    </div>`;
}
