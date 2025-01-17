import React, { Component, ReactNode } from 'react';
import { DEFAULT_BASEMAP_CONFIG, geomapLayerRegistry, defaultBaseLayer } from './layers/registry';
import { Map, MapBrowserEvent, View } from 'ol';
import Attribution from 'ol/control/Attribution';
import Zoom from 'ol/control/Zoom';
import ScaleLine from 'ol/control/ScaleLine';
import BaseLayer from 'ol/layer/Base';
import { defaults as interactionDefaults } from 'ol/interaction';
import MouseWheelZoom from 'ol/interaction/MouseWheelZoom';
import { createEmpty, extend } from 'ol/extent';
import VectorLayer from 'ol/layer/Vector';
import { Vector } from 'ol/source';
import LayerSwitcher from 'ol-layerswitcher';
import { isArray, isEqual } from 'lodash';
import Link from 'ol/interaction/Link';
import './GeomapPanel.css';

import {
  PanelData,
  MapLayerHandler,
  PanelProps,
  GrafanaTheme,
  DataHoverEvent,
  DataFrame,
} from '@grafana/data';
import { config } from '@grafana/runtime';

import { ControlsOptions, GeomapPanelOptions, MapViewConfig } from './types';
import { centerPointRegistry, MapCenterID } from './view';
import { fromLonLat, toLonLat } from 'ol/proj';
import { Coordinate } from 'ol/coordinate';
import { css } from '@emotion/css';
import { Portal, stylesFactory, VizTooltipContainer } from '@grafana/ui';
import { GeomapOverlay, OverlayProps } from './GeomapOverlay';
import { DebugOverlay } from './components/DebugOverlay';
import { getGlobalStyles } from './globalStyles';
import { GeomapHoverFeature, GeomapHoverPayload } from './event';
import { DataHoverView } from './components/DataHoverView';
import { ExtendMapLayerOptions } from './extension';

interface MapLayerState {
  config: ExtendMapLayerOptions;
  handler: MapLayerHandler;
  layer: BaseLayer; // used to add|remove
}

// Allows multiple panels to share the same view instance
let sharedView: View | undefined = undefined;
export let lastGeomapPanelInstance: GeomapPanel | undefined = undefined;

type Props = PanelProps<GeomapPanelOptions>;
interface State extends OverlayProps {
  ttip?: GeomapHoverPayload;
}

export class GeomapPanel extends Component<Props, State> {
  globalCSS = getGlobalStyles(config.theme2);

  counter = 0;
  hitToler?: number;
  map?: Map;
  layerSwitcher?: LayerSwitcher;
  basemap?: BaseLayer;
  layers: MapLayerState[] = [];
  mouseWheelZoom?: MouseWheelZoom;
  style = getStyles(config.theme);
  hoverPayload: GeomapHoverPayload = { point: {}, pageX: -1, pageY: -1 };
  readonly hoverEvent = new DataHoverEvent(this.hoverPayload);

  constructor(props: Props) {
    super(props);
    this.state = {};
  }

  componentDidMount() {
    lastGeomapPanelInstance = this;
  }

  shouldComponentUpdate(nextProps: Props) {
    if (!this.map) {
      return true; // not yet initalized
    }

    // Check for resize
    if (this.props.height !== nextProps.height || this.props.width !== nextProps.width) {
      this.map.updateSize();
    }

    // External configuration changed
    let layersChanged = false;
    if (this.props.options !== nextProps.options) {
      layersChanged = this.optionsChanged(nextProps.options);
    }

    // External data changed
    if (layersChanged || this.props.data !== nextProps.data) {
      this.dataChanged(nextProps.data);
    }

    return true; // always?
  }

  /**
   * Called when the panel options change
   */
  optionsChanged(options: GeomapPanelOptions): boolean {
    let layersChanged = false;
    const oldOptions = this.props.options;

    if (options.view !== oldOptions.view) {
      this.map!.setView(this.initMapView(options.view));
    }

    if (options.controls !== oldOptions.controls) {
      this.initControls(options.controls ?? { showZoom: true, showAttribution: true, showLayercontrol: true });
    }
    
    if (options.basemap !== oldOptions.basemap) {
      this.initBasemap(options.basemap);
      layersChanged = true;
    }

    if (options.layers !== oldOptions.layers) {
      this.initLayers(options.layers ?? []); // async
      layersChanged = true;
    }
    return layersChanged;
  }

  /**
   * Called when PanelData changes (query results etc)
   */
  dataChanged(data: PanelData) {
    for (const state of this.layers) {
      if (state.handler.update) {
        state.handler.update(data);
      }
    }
    if (this.props.options.view.id === MapCenterID.Auto && this.map) {
      let extent = createEmpty();
      const layers = this.map.getLayers().getArray();
      for (let layer of layers) {
        if (layer instanceof VectorLayer) {
          let source = layer.getSource();
          if (source !== undefined && source instanceof Vector) {
            let features = source.getFeatures();
            for (let feature of features) {
              let geo = feature.getGeometry();
              if (geo) {
                extend(extent, geo.getExtent());
              }
            }
          }
        }
      }
      if (!isEqual(extent, createEmpty())) {
        this.map.getView().fit(extent);
        let zoom = this.map.getView().getZoom();
        if (zoom) {
          this.map.getView().setZoom(zoom - 0.5);
        }
      }
    }
  }

  initMapRef = async (div: HTMLDivElement) => {
    if (this.map) {
      this.map.dispose();
    }

    if (!div) {
      this.map = undefined as unknown as Map;
      return;
    }
    const { options } = this.props;
    this.map = new Map({
      view: this.initMapView(options.view),
      pixelRatio: 1, // or zoom?
      layers: [], // loaded explicitly below
      controls: [],
      target: div,
      interactions: interactionDefaults({
        mouseWheelZoom: false, // managed by initControls
      }),
    });
    this.mouseWheelZoom = new MouseWheelZoom();
    this.map.addInteraction(this.mouseWheelZoom);
    this.initControls(options.controls);
    this.hitToler = options.controls.hitTolerance;
    this.initBasemap(options.basemap);
    await this.initLayers(options.layers);
    // Hide all layers but the first base map and the first layer
    this.map.on('rendercomplete', this.hideAllButFirstLayer);

    this.forceUpdate(); // first render 

    // Tooltip listener
    this.map.on('singleclick', this.pointerClickListener);

    this.map.addInteraction(new Link());
  };

  hideAllButFirstLayer = () => {
    if (!this.map) {
      return;
    }
    if(this.map!.getLayers().getArray().length===0) {
      return;
    }
    const layers = this.map!.getLayers().getArray();
    let i = 0;
    for (let layer of layers) {
      if(i++>1) {
        layer.setVisible(false);
      }
    }
    this.map.un('rendercomplete', this.hideAllButFirstLayer);
  }

  pointerClickListener = (evt: MapBrowserEvent<UIEvent>) => {
    if (!this.map) {
      return;
    }
    const mouse = evt.originalEvent as any;
    const pixel = this.map.getEventPixel(mouse);    
    this.map.forEachFeatureAtPixel(pixel, (feature, layer, geo) => {
      //console.log("click");
      let props = feature.getProperties()['frame'];
      //console.log(props);
      const fields = props["fields"];
      if (fields && isArray(fields)) {
        let hasLink = false;
        const linkFieldName = "link";
        let i=0;
        for(;i<fields.length&&!hasLink;i++) { 
          hasLink = (fields[i].name === linkFieldName);
        }
        if(hasLink) {
          const rowIndex = feature.getProperties()['rowIndex'];
          let uri = fields[i-1].values.buffer[rowIndex];
          const urlParams = new URLSearchParams(window.location.search);
          const x = urlParams.get('x');
          const y = urlParams.get('y');
          const z = urlParams.get('z');
          const r = urlParams.get('r');
          const l = urlParams.get('l');
          uri += "&var-x="+x+"&var-y="+y+"&var-z="+z+"&var-r="+r+"&var-l="+l;
          //console.log("rowIndex "+rowIndex);
          //console.log("link "+uri);
          window.open(uri,"_self");
        } else {
          console.log("no link");
        }  
      }
      //console.log(feature);
      //console.log(feature.getProperties()['frame']);
      //console.log(feature.getProperties()['rowIndex']);
    },
    {
      hitTolerance: this.hitToler
    });
  };

  pointerMoveListener = (evt: MapBrowserEvent<UIEvent>) => {
    if (!this.map) {
      return;
    }
    const mouse = evt.originalEvent as any;
    const pixel = this.map.getEventPixel(mouse);
    const hover = toLonLat(this.map.getCoordinateFromPixel(pixel));

    const { hoverPayload } = this;
    hoverPayload.pageX = mouse.pageX;
    hoverPayload.pageY = mouse.pageY;
    hoverPayload.point = {
      lat: hover[1],
      lon: hover[0],
    };
    hoverPayload.data = undefined;
    hoverPayload.rowIndex = undefined;
    hoverPayload.propsToShow = undefined;
    let ttip: GeomapHoverPayload = {} as GeomapHoverPayload;
    const features: GeomapHoverFeature[] = [];
    this.map.forEachFeatureAtPixel(pixel, (feature, layer, geo) => {
      let propsToShow = [];
      if (!hoverPayload.data) {
        let props = feature.getProperties();
        if (props['features'] && isArray(props['features']) && props['features'].length === 1) {
          props = props['features'][0].getProperties();
        }
        let frame = props['frame'];
        const thisLayer = layer.getProperties();
        if (frame) {
          for (let thisLayerName of typeof thisLayer.displayProperties !== 'undefined'
            ? thisLayer.displayProperties
            : []) {
            let found = frame.fields.filter((obj: { name: string }) => {
              return obj.name === thisLayerName;
            });
            propsToShow.push(found[0]);
          }
          hoverPayload.icon = thisLayer.icon ? thisLayer.icon : '';
          hoverPayload.data = ttip.data = frame as DataFrame;
          hoverPayload.propsToShow = propsToShow.length > 0 ? propsToShow : frame.fields;
          hoverPayload.titleField = frame.fields.filter((obj: { name: any }) => {
            return obj.name === thisLayer.titleField;
          });
          hoverPayload.timeField = frame.fields.filter((obj: { name: any }) => {
            return obj.name === thisLayer.timeField;
          });
          hoverPayload.rowIndex = ttip.rowIndex = props['rowIndex'];
        }
      }
      features.push({ feature, layer, geo });
    });
    this.hoverPayload.features = features.length ? features : undefined;
    this.props.eventBus.publish(this.hoverEvent);

    const currentTTip = this.state.ttip;
    if (ttip.data !== currentTTip?.data || ttip.rowIndex !== currentTTip?.rowIndex) {
      this.setState({ ttip: { ...hoverPayload } });
    }
  };

  async initBasemap(cfg: ExtendMapLayerOptions) {
    if (!this.map) {
      return;
    }

    if (!cfg?.type || config.geomapDisableCustomBaseLayer) {
      cfg = DEFAULT_BASEMAP_CONFIG;
    }
    const item = geomapLayerRegistry.getIfExists(cfg.type) ?? defaultBaseLayer;
    const handler = await item.create(this.map, cfg, config.theme2);
    const layer = handler.init();
    if (this.basemap) {
      this.map.removeLayer(this.basemap);
      this.basemap.dispose();
    }
    this.basemap = layer;
    this.map.getLayers().insertAt(0, this.basemap);
  }

  async initLayers(layers: ExtendMapLayerOptions[]) {
    // 1st remove existing layers
    for (const state of this.layers) {
      this.map!.removeLayer(state.layer);
      state.layer.dispose();
    }

    if (!layers) {
      layers = [];
    }

    const legends: React.ReactNode[] = [];
    this.layers = [];
    for (const overlay of layers) {
      const item = geomapLayerRegistry.getIfExists(overlay.type);
      if (!item) {
        console.warn('unknown layer type: ', overlay);
        continue; // TODO -- panel warning?
      }

      const handler = await item.create(this.map!, overlay, config.theme2);
      const layer = handler.init();
      (layer as any).___handler = handler;
      this.map!.addLayer(layer);
      this.layers.push({
        config: overlay,
        layer,
        handler,
      });
      
      if (handler.legend) {
        let str = `legend_${this.counter++}`;
        legends.push(<div id={str} key={str}>{handler.legend}</div>);
        layer.on('change:visible', function() { 
          let x = document.getElementById(str);
          if(x) {
            if (x.style.display === "none") {
              x.style.display = "block";
            } else {
              x.style.display = "none";
            }
          }
        });
      }
    }
    this.setState({ bottomLeft: legends });

    // Update data after init layers
    this.dataChanged(this.props.data);
  }

  initMapView(config: MapViewConfig): View {
    let view = new View({
      center: [0, 0],
      zoom: 1,
      showFullExtent: true, // alows zooming so the full range is visiable
    });

    // With shared views, all panels use the same view instance
    if (config.shared) {
      if (!sharedView) {
        sharedView = view;
      } else {
        view = sharedView;
      }
    }

    const v = centerPointRegistry.getIfExists(config.id);
    if (v) {
      let coord: Coordinate | undefined = undefined;
      if (v.lat == null) {
        if (v.id === MapCenterID.Coordinates || v.id === MapCenterID.Auto) {
          coord = [config.lon ?? 0, config.lat ?? 0];
        } else {
          console.log('TODO, view requires special handling', v);
        }
      } else {
        coord = [v.lon ?? 0, v.lat ?? 0];
      }
      if (coord) {
        view.setCenter(fromLonLat(coord));
      }
    }

    if (config.maxZoom) {
      view.setMaxZoom(config.maxZoom);
    }
    if (config.minZoom) {
      view.setMaxZoom(config.minZoom);
    }
    if (config.zoom) {
      view.setZoom(config.zoom);
    }
    return view;
  }

  initControls(options: ControlsOptions) {
    if (!this.map) {
      return;
    }
    this.map.getControls().clear();

    if (options.showZoom) {
      this.map.addControl(new Zoom());
    }

    if (options.showScale) {
      this.map.addControl(
        new ScaleLine({
          units: options.scaleUnits,
          minWidth: 100,
        })
      );
    }

    if (options.showLayercontrol) {
      this.layerSwitcher = new LayerSwitcher({
        label: 'L',
        tipLabel: 'Select layers',
        groupSelectStyle: 'none',
        activationMode: 'click',
      });
      this.map.addControl(this.layerSwitcher);
    }

    const map = this.map;

    let zoomCluster = function (pixel: number[]) {
      let feature = map.forEachFeatureAtPixel(pixel, function (feature) {
        return feature;
      });

      if (feature) {
        let features = feature.get('features');
        if (features && features.length > 1) {
          let extent = createEmpty();
          features.forEach(function (f: any) {
            extend(extent, f.getGeometry().getExtent());
          });
          const view = map.getView();
          view.fit(extent);
          const currentZoom = view.getZoom();
          if (currentZoom) {
            map.getView().setZoom(currentZoom - 2);
          }
        }
      }
    };

    this.map.on('click', function (evt: MapBrowserEvent<any>) {
      zoomCluster(evt.pixel);
    });

    this.mouseWheelZoom!.setActive(Boolean(options.mouseWheelZoom));

    if (options.showAttribution) {
      this.map.addControl(new Attribution({ collapsed: true, collapsible: true }));
    }

    // Update the react overlays
    let topRight: ReactNode[] = [];
    if (options.showDebug) {
      topRight = [<DebugOverlay key="debug" map={this.map} />];
    }

    this.setState({ topRight });
  }

  render() {
    const { ttip, topRight, bottomLeft } = this.state;

    return (
      <>
        {
          //<Global styles={this.globalCSS} />
        }
        <div className={this.style.wrap}>
          <div className={this.style.map} ref={this.initMapRef}></div>
          <GeomapOverlay bottomLeft={bottomLeft} topRight={topRight} />
        </div>
        <Portal>
          {ttip && ttip.data && (
            <VizTooltipContainer
              className={this.style.viz}
              position={{ x: ttip.pageX, y: ttip.pageY }}
              offset={{ x: 10, y: 10 }}
            >
              <DataHoverView {...ttip} />
            </VizTooltipContainer>
          )}
        </Portal>
      </>
    );
  }
}

const getStyles = stylesFactory((theme: GrafanaTheme) => ({
  wrap: css`
    position: relative;
    width: 100%;
    height: 100%;
  `,
  map: css`
    position: absolute;
    z-index: 0;
    width: 100%;
    height: 100%;
  `,
  viz: css`
    border-radius: 10px;
  `,
}));
