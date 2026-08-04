// Replaced in Task 10. Renders the plain coordinate fields so the panels tab
// is usable and testable before the picker exists.
//
// Contract: the picker communicates with the form through `container.dataset`,
// not through named inputs — `save()` in panels.js reads latitude/longitude/
// label/timezone off the container's dataset, ignoring any form fields the
// picker happens to render. This stub has no city name or timezone to offer,
// so it only ever sets dataset.latitude/dataset.longitude; `save()` already
// guards for dataset.label/dataset.timezone being absent.
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

  const latInput = container.querySelector('#lat');
  const lonInput = container.querySelector('#lon');

  const sync = () => {
    container.dataset.latitude = latInput.value;
    container.dataset.longitude = lonInput.value;
  };

  latInput.addEventListener('input', sync);
  lonInput.addEventListener('input', sync);

  // Seed the dataset immediately so an unedited-but-existing location still
  // round-trips on save.
  sync();
}
