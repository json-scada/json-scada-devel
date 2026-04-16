---
name: svg-scada  
description: Generate, structure, and markup scalable vector graphics (SVG) files that natively interface with SCADA markups by embedding strict, HTML-escaped JSON configurations into the `inkscape:label` attribute of SVG elements. Dedicated to the SCADAvis.io / OSHMI / JSON-SCADA projects and integration specialist. Use when user asks to edit or create SVG files with SCADA animations or markup (SVG or SCADA or SAGE or XSAC or Inkscape or SVG-Edit or SVG-SCADA or JSON-SCADA or SCADAvis or OSHMI).
---

# SVG SCADA Generation Agent Skills

## Overview
This agent is designed to generate, structure, and markup scalable vector graphics (SVG) files that natively interface with SCADA markups by embedding strict, HTML-escaped JSON configurations into the `inkscape:label` attribute of SVG elements. It is dedicated to the SCADAvis.io / OSHMI / JSON-SCADA projects.

## 📐 Core SVG & JSON Serialization Rules

1. **Namespace Required:** The `<svg>` root element **must** include the Inkscape namespace: `xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"`.
2. **JSON Object Structure:** The SCADA parameters must be a flat JSON dictionary. The JSON content of SCADA markup must be put in the " inkscape:label" attribute of the SVG element affected.
3. **The "attr" Key:** The selected animation "Tab" (action type) must be stored in the `"attr"` key (e.g., `"attr":"set"`, `"attr":"get"`, `"attr":"bar"`).
4. **Lowercase Keys:** All JSON keys correspond to the dialog fields and MUST be lowercase (e.g., `"tag"`, `"src"`, `"prompt"`, `"format"`, `"min"`, `"max"`).
5. **XML-Entity Escaping:** The JSON string MUST be HTML-escaped so that standard double-quotes inside the JSON become `&quot;`. The attribute itself is wrapped in standard double quotes.
   * *Correct Example:* `inkscape:label="{&quot;attr&quot;:&quot;get&quot;,&quot;tag&quot;:&quot;TAG1&quot;,&quot;format&quot;:&quot;%5.2f&quot;}"`

---

## ⚙️ SCADA Animations & Attribute Mapping

Use the following JSON dictionary structures embedded as HTML-escaped strings for different SCADA behaviors.
Multiple behaviors can be combined by embedding multiple JSON objects in the same `inkscape:label` attribute, as a JSON array but without the surrounding square brackets `[]` (e.g., `{"attr":"get", "tag":"TAG_NAME"},{"attr":"color", "tag":"TAG_NAME", "limit1":"1", "color1":"red|"}`).

### 1. Get (Text Formatting)
* Targets `<text>` SVG elements.
* The `<text>` element should contain a `<tspan>` child element where the format string is placed (e.g., `%5.2f`, `.3s`, `off|on|failed`).
* **Fields:** `"attr":"get"`, `"tag"`, `align` (e.g., `"align":"Right"`), `type` (e.g., `"type":"Good"`). All fields are required to ensure proper parsing and functionality.
* **JSON:** `{"attr":"get", "tag":"TAG_NAME", align":"Right", "type":"Good"}`
* **Format Strings should be put in the tspan element:** 
  * Printf (`%5.2f`), d3 (`.3s`), Boolean (`off|on|failed`).
  * Flow arrows: append `u^`, `d^`, `r^`, `l^`, `a^` to show direction.
* Example: `<text
       xml:space="preserve"
       style="font-style:normal;font-variant:normal;font-weight:normal;font-stretch:normal;line-height:0%;font-family:'Microsoft Sans Serif';-inkscape-font-specification:'Microsoft Sans Serif';text-align:end;letter-spacing:0px;word-spacing:0px;writing-mode:lr-tb;text-anchor:end;fill:#6a43e5;fill-opacity:1;stroke:none"
       x="-310"
       y="-232.63782"
       id="mw_model"
       inkscape:label="{&quot;align&quot;:&quot;Right&quot;,&quot;attr&quot;:&quot;get&quot;,&quot;tag&quot;:&quot;%n&quot;,&quot;type&quot;:&quot;Good&quot;}"><tspan
         sodipodi:role="line"
         id="tspan4770"
         x="-310"
         y="-232.63782"
         style="font-size:22px;line-height:1.25">%5.1f</tspan></text>
    `.

### 2. Color (Fill, Stroke, & Attributes)
* **Target:** SVG drawing objects (Exclude `<g>`).
* **Fields:** `"attr":"color"`, `"tag"`, `"list"` as an array of `{"data":"VALUE_LIMIT"}`, `{"param":"COLOR_CODE"}`, `{"tag","TAG_NAME"}`.
* **Color Syntax:** `"fill|stroke"`, e.g., `"red|green"`, `"|yellow"` (stroke only), `"black|"` (fill only). 
* **Limit Constants:** `"a"` (alarm), `"f"` (failed), `"1"` (off), `"2"` (on).
* **JSON:** `{"attr":"color", "tag":"TAG_NAME", "list":[{"data":"1", "param":"red|", "tag":"%n"}, {"data":"2", "param":"green|", "tag":"%n"}, {"data":"f", "param":"gray|", "tag":"%n"}]}`. All fields are required to ensure proper parsing and functionality.
* **Attribute Hack:** Use the prefix `"attrib:"` followed by SVG properties for the "data" field of "list" arrray (e.g., `{"data":"attrib: style=fill:red;text-decoration:underline;"}`) to manipulate SVG properties instead of just colors.
* Example: `inkscape:label="{&quot;attr&quot;:&quot;color&quot;,&quot;list&quot;:[{&quot;data&quot;:&quot;-99999&quot;,&quot;param&quot;:&quot;-cor-11|&quot;,&quot;tag&quot;:&quot;%n&quot;},{&quot;data&quot;:&quot;-500&quot;,&quot;param&quot;:&quot;-cor-20|&quot;,&quot;tag&quot;:&quot;%n&quot;},{&quot;data&quot;:&quot;500&quot;,&quot;param&quot;:&quot;-cor-11|&quot;,&quot;tag&quot;:&quot;%n&quot;},{&quot;data&quot;:&quot;c&quot;,&quot;param&quot;:&quot;-cor-41|&quot;,&quot;tag&quot;:&quot;%n&quot;},{&quot;data&quot;:&quot;n&quot;,&quot;param&quot;:&quot;-cor-42|&quot;,&quot;tag&quot;:&quot;%n&quot;},{&quot;data&quot;:&quot;f&quot;,&quot;param&quot;:&quot;-cor-12|&quot;,&quot;tag&quot;:&quot;%n&quot;}]}"`.

### 3. Bar, Opacity, Rotate, Slider
* **Bar:** `{"attr":"bar", "tag":"TAG", "min":0, "max":100}` (Targets `<rect>` SVG elements. Max matches the the variable value proportionally to the height of the rectangle). All fields are required to ensure proper parsing and functionality.
* **Rotate:** `{"attr":"rotate", "tag":"TAG", "min":0, "max":100}` (Rotates 360° from Min to Max). Targets any SVG element. All fields are required to ensure proper parsing and functionality.
* **Slider:** `{"attr":"slider", "tag":"TAG", "min":0, "max":100}` (Linearly transitions from the original object's position to a cloned object's (`<use>` SVG element) position). Targets any SVG element. All fields are required to ensure proper parsing and functionality.

### 4. Tooltips
* Targets SVG element.
* **JSON:** `{"attr":"tooltips", "line1":"Literal text", "line2":"!EVAL $V('TAG') !END"}`. All fields are required to ensure proper parsing and functionality.

### 5. Popup & Open
* Targets SVG element.
* **Popup:** `{"attr":"popup", "source":"TAG_OR_ACTION"}` 
  *(Actions: `block`, `notrace`, `preview:URL`).*
* **Open (URL):** `{"attr":"open", "source_type":"URL", "source":"new:URL"}`
* **Open (Trends):** `{"attr":"open", "source_type":"Tag", "source":"TAG", "width":60, "height":100}` *(Draws a line-trend inside a `<rect>`)*.
* All fields are required to ensure proper parsing and functionality.

### 6. Faceplate (Indirect Variables)
* Targets SVG group `<g>` elements.
* **JSON:** `{"attr":"faceplate", "variable":"n", "value":"ACTUAL_TAG_NAME"}`
* **Inner Elements:** Elements inside the group reference the variable using `%` (e.g., `"tag":"%n"`).
* All fields are required to ensure proper parsing and functionality.

### 7. Set (Macros & Functions)
* **Target:** Any object.
* **Fields:** `"attr":"set"`, `"tag"`, `"src"`, `"prompt"`
* **Use Cases:**
  * **Arc/Doughnut:** `{"attr":"set", "tag":"#arc", "src":"TAG1", "prompt":"0,100,75"}` *(Prompt = Min,Max,InnerRadius)*.
  * **Execute Script:** `{"attr":"set", "tag":"#exec_once", "src":"console.log('loaded');"}`
  * **Clone Properties:** `{"attr":"set", "tag":"#copy_xsac_from", "src":"MASTER_ELEMENT_ID"}`
  * **Vega Charts:** `{"attr":"set", "tag":"#vega4", "src":"TAG1,TAG2", "prompt":"URL_OR_JSON"}`
  * **ONVIF Camera:** `{"attr":"set", "tag":"#camera", "src":"CAM_NAME", "prompt":"width=500 height=500"}`
* All fields are required to ensure proper parsing and functionality.

---

## 💻 AI Implementation Example: Accurate Escaped Output

**User Prompt:** Create a digital text display for a pump status and a gauge (using the `#arc` set function), fully bound with JSON-SCADA logic.

**AI Response Output Format:**
```xml
<svg xmlns="http://www.w3.org/2000/svg" 
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" 
    xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
    xmlns="http://www.w3.org/2000/svg"
    xmlns:svg="http://www.w3.org/2000/svg"
    xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
    xmlns:cc="http://creativecommons.org/ns#"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
      width="2400" height="1500" viewBox="0 0 2400 1500">

    <g
     inkscape:label="Layer 1"
     inkscape:groupmode="layer"
     id="layer1">

      <!-- Example 1: Pump Status Digital Display -->
      <g id="pump_status_group">
        
        <!-- Background changes color based on PUMP_01 state -->
        <!-- JSON: {"attr":"color", "tag":"PUMP_01", "limit1":"1", "color1":"red|", "limit2":"2", "color2":"green|", "limit3":"f", "color3":"gray|"} -->
        <rect id="pump_bg" 
              x="100" y="100" width="200" height="50" 
              fill="gray" stroke="black" stroke-width="2"
              inkscape:label="{&quot;attr&quot;:&quot;color&quot;,&quot;tag&quot;:&quot;PUMP_01&quot;,&quot;limit1&quot;:&quot;1&quot;,&quot;color1&quot;:&quot;red|&quot;,&quot;limit2&quot;:&quot;2&quot;,&quot;color2&quot;:&quot;green|&quot;,&quot;limit3&quot;:&quot;f&quot;,&quot;color3&quot;:&quot;gray|&quot;}" />

        <!-- Text formats the PUMP_01 state into strings -->
        <!-- JSON: {"attr":"get", "tag":"PUMP_01", "format":"STOPPED|RUNNING|COMM ERROR"} -->
        <text id="pump_text" 
              x="200" y="135" 
              font-family="Arial" font-size="24" text-anchor="middle" fill="white"
              inkscape:label="{&quot;attr&quot;:&quot;get&quot;,&quot;tag&quot;:&quot;PUMP_01&quot;,&quot;format&quot;:&quot;STOPPED|RUNNING|COMM ERROR&quot;}">
            STOPPED
        </text>
      </g>

      <!-- Example 2: Analog Level using #arc donut macro -->
      <!-- JSON: {"attr":"set", "tag":"#arc", "src":"TANK_LVL", "prompt":"0,100,75"} -->
      <g id="tank_arc_group">
        <path id="tank_level_arc" 
              d="M 500,500 A 100,100 0 0,1 600,600" 
              fill="blue"
              inkscape:label="{&quot;attr&quot;:&quot;set&quot;,&quot;tag&quot;:&quot;#arc&quot;,&quot;src&quot;:&quot;TANK_LVL&quot;,&quot;prompt&quot;:&quot;0,100,75&quot;}" />
      </g>
    </g>

</svg>
```

## Complete Complex SVG Example

```xml
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape (http://www.inkscape.org/) -->

<svg
   width="1000"
   height="1000"
   viewBox="0 0 264.58333 264.58333"
   version="1.1"
   inkscape:version="1.4.3 (5eeaa1c2f6, 2026-04-11)"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns="http://www.w3.org/2000/svg"
   xmlns:svg="http://www.w3.org/2000/svg">
  <g
     inkscape:label="Layer 1"
     inkscape:groupmode="layer"
     id="layer1">
    <rect
       style="opacity:0.98;fill:#dde9af;fill-opacity:1;stroke:none;stroke-width:1.68677;stroke-miterlimit:4;stroke-dasharray:none;stroke-dashoffset:0"
       id="rect7554"
       width="156.36104"
       height="6.2012873"
       x="7.2491589"
       y="12.074057" />
    <rect
       style="opacity:0.98;fill:#aa0000;fill-opacity:1;stroke:#ff0000;stroke-width:1.0958;stroke-miterlimit:4;stroke-dasharray:none;stroke-dashoffset:0"
       id="rect27732"
       width="10.179841"
       height="8.9269915"
       x="104.25072"
       y="144.14891" />
    <text
       xml:space="preserve"
       style="font-style:normal;font-variant:normal;font-weight:bold;font-stretch:normal;font-size:5.18951px;line-height:1.25;font-family:sans-serif;-inkscape-font-specification:'sans-serif, Bold';font-variant-ligatures:normal;font-variant-caps:normal;font-variant-numeric:normal;font-feature-settings:normal;text-align:start;letter-spacing:0px;word-spacing:0px;writing-mode:lr-tb;text-anchor:start;fill:#000000;fill-opacity:1;stroke:none;stroke-width:0.129736"
       x="9.4246464"
       y="24.715755"
       id="text6842-5-0"><tspan
         sodipodi:role="line"
         id="tspan6840-7-0"
         x="9.4246464"
         y="24.715755"
         style="font-style:normal;font-variant:normal;font-weight:bold;font-stretch:normal;font-size:5.18951px;font-family:sans-serif;-inkscape-font-specification:'sans-serif, Bold';font-variant-ligatures:normal;font-variant-caps:normal;font-variant-numeric:normal;font-feature-settings:normal;text-align:start;writing-mode:lr-tb;text-anchor:start;stroke-width:0.129736">Get Tab</tspan></text>
    <text
       xml:space="preserve"
       style="font-style:normal;font-weight:normal;font-size:5.62318px;line-height:1.25;font-family:sans-serif;letter-spacing:0px;word-spacing:0px;fill:#0000ff;fill-opacity:1;stroke:none;stroke-width:0.140579"
       x="13.312727"
       y="47.067356"
       id="text8053"
       inkscape:label="{&quot;align&quot;:&quot;Right&quot;,&quot;attr&quot;:&quot;get&quot;,&quot;tag&quot;:&quot;@1&quot;,&quot;type&quot;:&quot;Good&quot;}"><tspan
         sodipodi:role="line"
         id="tspan8051"
         x="13.312727"
         y="47.067356"
         style="fill:#0000ff;stroke-width:0.140579">%f</tspan></text>
    <text
       xml:space="preserve"
       style="font-style:normal;font-weight:normal;font-size:5.62318px;line-height:1.25;font-family:sans-serif;letter-spacing:0px;word-spacing:0px;fill:#0000ff;fill-opacity:1;stroke:none;stroke-width:0.140579"
       x="13.312727"
       y="53.489655"
       id="text8053-5"
       inkscape:label="{&quot;align&quot;:&quot;Right&quot;,&quot;attr&quot;:&quot;get&quot;,&quot;tag&quot;:&quot;@1&quot;,&quot;type&quot;:&quot;Good&quot;}"><tspan
         sodipodi:role="line"
         id="tspan8051-8"
         x="13.312727"
         y="53.489655"
         style="fill:#0000ff;stroke-width:0.140579">%.1f</tspan></text>
    <text
       xml:space="preserve"
       style="font-style:normal;font-weight:normal;font-size:5.62318px;line-height:1.25;font-family:sans-serif;letter-spacing:0px;word-spacing:0px;fill:#0000ff;fill-opacity:1;stroke:none;stroke-width:0.140579"
       x="13.312727"
       y="59.911945"
       id="text8053-5-6"
       inkscape:label="{&quot;align&quot;:&quot;Right&quot;,&quot;attr&quot;:&quot;get&quot;,&quot;tag&quot;:&quot;@1&quot;,&quot;type&quot;:&quot;Good&quot;}"><tspan
         sodipodi:role="line"
         id="tspan8051-8-1"
         x="13.312727"
         y="59.911945"
         style="fill:#0000ff;stroke-width:0.140579">%08.2f</tspan></text>
    <text
       xml:space="preserve"
       style="font-style:normal;font-weight:normal;font-size:5.62318px;line-height:1.25;font-family:sans-serif;letter-spacing:0px;word-spacing:0px;fill:#0000ff;fill-opacity:1;stroke:none;stroke-width:0.140579"
       x="89.871658"
       y="47.325474"
       id="text8053-5-6-7"
       inkscape:label="{&quot;align&quot;:&quot;Right&quot;,&quot;attr&quot;:&quot;get&quot;,&quot;tag&quot;:&quot;@1&quot;,&quot;type&quot;:&quot;Good&quot;}"><tspan
         sodipodi:role="line"
         id="tspan8051-8-1-4"
         x="89.871658"
         y="47.325474"
         style="fill:#0000ff;stroke-width:0.140579">.^20</tspan></text>
    <text
       xml:space="preserve"
       style="font-style:normal;font-weight:normal;font-size:5.62318px;line-height:1.25;font-family:sans-serif;letter-spacing:0px;word-spacing:0px;fill:#0000ff;fill-opacity:1;stroke:none;stroke-width:0.140579"
       x="90.162704"
       y="54.561752"
       id="text8053-5-6-7-8"
       inkscape:label="{&quot;align&quot;:&quot;Right&quot;,&quot;attr&quot;:&quot;get&quot;,&quot;tag&quot;:&quot;@1&quot;,&quot;type&quot;:&quot;Good&quot;}"><tspan
         sodipodi:role="line"
         id="tspan8051-8-1-4-0"
         x="90.162704"
         y="54.561752"
         style="fill:#0000ff;stroke-width:0.140579">,.2r</tspan></text>
    <text
       xml:space="preserve"
       style="font-style:normal;font-weight:normal;font-size:5.62318px;line-height:1.25;font-family:sans-serif;letter-spacing:0px;word-spacing:0px;fill:#0000ff;fill-opacity:1;stroke:none;stroke-width:0.140579"
       x="13.213881"
       y="66.334244"
       id="text8053-5-6-75"
       inkscape:label="{&quot;align&quot;:&quot;Right&quot;,&quot;attr&quot;:&quot;get&quot;,&quot;tag&quot;:&quot;@1&quot;,&quot;type&quot;:&quot;Good&quot;}"><tspan
         sodipodi:role="line"
         id="tspan8051-8-1-2"
         x="13.213881"
         y="66.334244"
         style="fill:#0000ff;stroke-width:0.140579">r^%.2f</tspan></text>
    <g
       id="g7562"
       inkscape:label="{&quot;attr&quot;:&quot;tooltips&quot;,&quot;param&quot;:[&quot;Use the printf convention to format numbers and strings.&quot;],&quot;size&quot;:12,&quot;style&quot;:&quot;&quot;}"
       transform="matrix(0.15660616,0,0,0.15660616,6.2852055,8.0136647)">
      <text
         id="text6842-5-0-9"
         y="196.34877"
         x="20.477276"
         style="font-style:normal;font-weight:normal;font-size:33.1369px;line-height:1.25;font-family:sans-serif;letter-spacing:0px;word-spacing:0px;fill:#000000;fill-opacity:1;stroke:none;stroke-width:0.828422"
         xml:space="preserve"><tspan
           style="stroke-width:0.828422"
           y="196.34877"
           x="20.477276"
           id="tspan6840-7-0-3"
           sodipodi:role="line">Printf Convention</tspan></text>
    </g>
    <g
       id="g7566"
       inkscape:label="{&quot;attr&quot;:&quot;tooltips&quot;,&quot;param&quot;:[&quot;The D3 convention is more powerful than the printf convention.&quot;],&quot;size&quot;:12,&quot;style&quot;:&quot;&quot;}"
       transform="matrix(0.15660616,0,0,0.15660616,18.139407,8.0136647)">
      <text
         id="text6842-5-0-9-7"
         y="197.61737"
         x="434.63873"
         style="font-style:normal;font-weight:normal;font-size:33.1369px;line-height:1.25;font-family:sans-serif;letter-spacing:0px;word-spacing:0px;fill:#000000;fill-opacity:1;stroke:none;stroke-width:0.828422"
         xml:space="preserve"><tspan
           style="stroke-width:0.828422"
           y="197.61737"
           x="434.63873"
           id="tspan6840-7-0-3-2"
           sodipodi:role="line">D3 Convention</tspan></text>
    </g>
    <text
       xml:space="preserve"
       style="font-style:normal;font-variant:normal;font-weight:bold;font-stretch:normal;font-size:5.18951px;line-height:1.25;font-family:sans-serif;-inkscape-font-specification:'sans-serif, Bold';font-variant-ligatures:normal;font-variant-caps:normal;font-variant-numeric:normal;font-feature-settings:normal;text-align:start;letter-spacing:0px;word-spacing:0px;writing-mode:lr-tb;text-anchor:start;fill:#000000;fill-opacity:1;stroke:none;stroke-width:0.129736"
       x="9.4246464"
       y="123.66969"
       id="text6842-5-0-1"><tspan
         sodipodi:role="line"
         id="tspan6840-7-0-8"
         x="9.4246464"
         y="123.66969"
         style="font-style:normal;font-variant:normal;font-weight:bold;font-stretch:normal;font-size:5.18951px;font-family:sans-serif;-inkscape-font-specification:'sans-serif, Bold';font-variant-ligatures:normal;font-variant-caps:normal;font-variant-numeric:normal;font-feature-settings:normal;text-align:start;writing-mode:lr-tb;text-anchor:start;stroke-width:0.129736">Color Tab</tspan></text>
    <rect
       style="fill:#ffffff;fill-opacity:1;stroke:#000000;stroke-width:0.626423;stroke-miterlimit:4;stroke-dasharray:none"
       id="rect3847"
       width="10.962432"
       height="10.962432"
       x="15.37694"
       y="145.01048"
       inkscape:label="{&quot;attr&quot;:&quot;color&quot;,&quot;list&quot;:[{&quot;data&quot;:&quot;-999999&quot;,&quot;param&quot;:&quot;none|red&quot;,&quot;tag&quot;:&quot;@1&quot;}]}" />
    <rect
       style="fill:#ffffff;fill-opacity:1;stroke:#000000;stroke-width:0.626423;stroke-miterlimit:4;stroke-dasharray:none"
       id="rect3847-6"
       width="10.962432"
       height="10.962432"
       x="42.939621"
       y="145.01048"
       inkscape:label="{&quot;attr&quot;:&quot;color&quot;,&quot;list&quot;:[{&quot;data&quot;:&quot;-999999&quot;,&quot;param&quot;:&quot;#00ff00|black&quot;,&quot;tag&quot;:&quot;@1&quot;},{&quot;data&quot;:&quot;0&quot;,&quot;param&quot;:&quot;#00ff00|black&quot;,&quot;tag&quot;:&quot;@1&quot;},{&quot;data&quot;:&quot;200&quot;,&quot;param&quot;:&quot;red|black&quot;,&quot;tag&quot;:&quot;@1&quot;}]}" />
    <text
       xml:space="preserve"
       style="font-style:normal;font-weight:normal;font-size:2.58978px;line-height:1.25;font-family:sans-serif;letter-spacing:0px;word-spacing:0px;fill:#000000;fill-opacity:1;stroke:none;stroke-width:0.0647447"
       x="14.853045"
       y="138.24452"
       id="text6842-5-0-1-3"><tspan
         sodipodi:role="line"
         id="tspan6840-7-0-8-9"
         x="14.853045"
         y="138.24452"
         style="stroke-width:0.0647447">Fill | Stroke</tspan></text>
    <text
       xml:space="preserve"
       style="font-style:normal;font-weight:normal;font-size:2.58978px;line-height:1.25;font-family:sans-serif;letter-spacing:0px;word-spacing:0px;fill:#000000;fill-opacity:1;stroke:none;stroke-width:0.0647447"
       x="42.415726"
       y="138.24452"
       id="text6842-5-0-1-3-7"><tspan
         sodipodi:role="line"
         id="tspan6840-7-0-8-9-9"
         x="42.415726"
         y="138.24452"
         style="stroke-width:0.0647447">Change Colors</tspan><tspan
         sodipodi:role="line"
         x="42.415726"
         y="141.48175"
         style="stroke-width:0.0647447"
         id="tspan3900">With Values</tspan></text>
    <rect
       style="opacity:0.98;fill:#ffffff;fill-opacity:1;stroke:#000000;stroke-width:1.56606;stroke-miterlimit:4;stroke-dasharray:none"
       id="rect3847-6-5"
       width="10.962432"
       height="10.962432"
       x="70.189095"
       y="145.01048"
       inkscape:label="{&quot;attr&quot;:&quot;color&quot;,&quot;list&quot;:[{&quot;data&quot;:&quot;-999999&quot;,&quot;param&quot;:&quot;green|black&quot;,&quot;tag&quot;:&quot;@1&quot;},{&quot;data&quot;:&quot;0&quot;,&quot;param&quot;:&quot;green|black&quot;,&quot;tag&quot;:&quot;@1&quot;},{&quot;data&quot;:&quot;200&quot;,&quot;param&quot;:&quot;@red|black&quot;,&quot;tag&quot;:&quot;@1&quot;}]}" />
    <text
       xml:space="preserve"
       style="font-style:normal;font-weight:normal;font-size:2.58978px;line-height:1.25;font-family:sans-serif;letter-spacing:0px;word-spacing:0px;fill:#000000;fill-opacity:1;stroke:none;stroke-width:0.0647447"
       x="69.35199"
       y="138.24452"
       id="text6842-5-0-1-3-7-0"><tspan
         sodipodi:role="line"
         x="69.35199"
         y="138.24452"
         style="stroke-width:0.0647447"
         id="tspan3900-6">Color</tspan><tspan
         sodipodi:role="line"
         x="69.35199"
         y="141.48175"
         style="stroke-width:0.0647447"
         id="tspan3940">Interpolation</tspan></text>
    <rect
       style="fill:#ffffff;fill-opacity:1;stroke:#000000;stroke-width:0.626423;stroke-miterlimit:4;stroke-dasharray:none"
       id="rect3847-6-5-1"
       width="10.962432"
       height="10.962432"
       x="99.944267"
       y="144.69727"
       inkscape:label="{&quot;attr&quot;:&quot;color&quot;,&quot;list&quot;:[{&quot;data&quot;:&quot;-999999&quot;,&quot;param&quot;:&quot;attrib: opacity=0.1&quot;,&quot;tag&quot;:&quot;@1&quot;},{&quot;data&quot;:&quot;0&quot;,&quot;param&quot;:&quot;attrib: opacity=0.3&quot;,&quot;tag&quot;:&quot;@1&quot;},{&quot;data&quot;:&quot;199.9999&quot;,&quot;param&quot;:&quot;attrib: opacity=0.9&quot;,&quot;tag&quot;:&quot;@1&quot;}]}" />
    <text
       xml:space="preserve"
       style="font-style:normal;font-weight:normal;font-size:2.58978px;line-height:1.25;font-family:sans-serif;letter-spacing:0px;word-spacing:0px;fill:#000000;fill-opacity:1;stroke:none;stroke-width:0.0647447"
       x="99.107155"
       y="137.93132"
       id="text6842-5-0-1-3-7-0-6"><tspan
         sodipodi:role="line"
         x="99.107155"
         y="137.93132"
         style="stroke-width:0.0647447"
         id="tspan3968">Change</tspan><tspan
         sodipodi:role="line"
         x="99.107155"
         y="141.16855"
         style="stroke-width:0.0647447"
         id="tspan3996">Attributes</tspan></text>
    <rect
       style="fill:#ffffff;fill-opacity:1;stroke:#000000;stroke-width:0.626423;stroke-miterlimit:4;stroke-dasharray:none"
       id="rect3847-6-5-1-4"
       width="10.962432"
       height="10.962432"
       x="128.7598"
       y="144.69727"
       inkscape:label="{&quot;attr&quot;:&quot;color&quot;,&quot;list&quot;:[{&quot;data&quot;:&quot;-999999&quot;,&quot;param&quot;:&quot;green|black&quot;,&quot;tag&quot;:&quot;@1&quot;},{&quot;data&quot;:&quot;0&quot;,&quot;param&quot;:&quot;green|black&quot;,&quot;tag&quot;:&quot;@1&quot;},{&quot;data&quot;:&quot;199.9999&quot;,&quot;param&quot;:&quot;@red|black&quot;,&quot;tag&quot;:&quot;@1&quot;},{&quot;data&quot;:&quot;200&quot;,&quot;param&quot;:&quot;script: $W.RemoveAnimate( thisobj ); $W.Animate( thisobj, 'animate', {'attributeName': 'width', 'from': 74, 'to': 100, 'repeatCount':5,'dur': 1 } );&quot;,&quot;tag&quot;:&quot;@1&quot;}]}" />
    <text
       xml:space="preserve"
       style="font-style:normal;font-weight:normal;font-size:2.58978px;line-height:1.25;font-family:sans-serif;letter-spacing:0px;word-spacing:0px;fill:#000000;fill-opacity:1;stroke:none;stroke-width:0.0647447"
       x="127.9227"
       y="137.93132"
       id="text6842-5-0-1-3-7-0-6-3"><tspan
         sodipodi:role="line"
         x="127.9227"
         y="137.93132"
         style="stroke-width:0.0647447"
         id="tspan3940-0-2">Trigger</tspan><tspan
         sodipodi:role="line"
         x="127.9227"
         y="141.16855"
         style="stroke-width:0.0647447"
         id="tspan3968-2">Animation</tspan></text>
    <text
       xml:space="preserve"
       style="font-style:normal;font-variant:normal;font-weight:normal;font-stretch:normal;font-size:4.26846px;line-height:1.25;font-family:sans-serif;-inkscape-font-specification:'sans-serif, Normal';font-variant-ligatures:normal;font-variant-caps:normal;font-variant-numeric:normal;font-feature-settings:normal;text-align:center;letter-spacing:0px;word-spacing:0px;writing-mode:lr-tb;text-anchor:middle;fill:#000000;fill-opacity:1;stroke:none;stroke-width:0.106711"
       x="76.374832"
       y="161.14989"
       id="text8053-50"
       inkscape:label="{&quot;align&quot;:&quot;Right&quot;,&quot;attr&quot;:&quot;get&quot;,&quot;tag&quot;:&quot;@1&quot;,&quot;type&quot;:&quot;Good&quot;}"><tspan
         sodipodi:role="line"
         id="tspan8051-4"
         x="76.374832"
         y="161.14989"
         style="font-style:normal;font-variant:normal;font-weight:normal;font-stretch:normal;font-size:4.26846px;font-family:sans-serif;-inkscape-font-specification:'sans-serif, Normal';font-variant-ligatures:normal;font-variant-caps:normal;font-variant-numeric:normal;font-feature-settings:normal;text-align:center;writing-mode:lr-tb;text-anchor:middle;stroke-width:0.106711">%.1f</tspan></text>
    <text
       xml:space="preserve"
       style="font-style:normal;font-variant:normal;font-weight:normal;font-stretch:normal;font-size:4.01455px;line-height:1.25;font-family:sans-serif;-inkscape-font-specification:'sans-serif, Normal';font-variant-ligatures:normal;font-variant-caps:normal;font-variant-numeric:normal;font-feature-settings:normal;text-align:center;letter-spacing:0px;word-spacing:0px;writing-mode:lr-tb;text-anchor:middle;fill:#000000;fill-opacity:1;stroke:none;stroke-width:0.100363"
       x="105.20885"
       y="160.7991"
       id="text8053-8"
       inkscape:label="{&quot;attr&quot;:&quot;color&quot;,&quot;list&quot;:[{&quot;data&quot;:&quot;-999999&quot;,&quot;param&quot;:&quot;attrib: style=fill:green;text-decoration:none;&quot;,&quot;tag&quot;:&quot;@1&quot;},{&quot;data&quot;:&quot;100&quot;,&quot;param&quot;:&quot;attrib: style=fill:red;text-decoration:underline;&quot;,&quot;tag&quot;:&quot;@1&quot;}]},{&quot;align&quot;:&quot;Right&quot;,&quot;attr&quot;:&quot;get&quot;,&quot;tag&quot;:&quot;Allen Junction_H2S&quot;,&quot;type&quot;:&quot;Good&quot;}"><tspan
         sodipodi:role="line"
         id="tspan8051-1"
         x="105.20885"
         y="160.7991"
         style="font-style:normal;font-variant:normal;font-weight:normal;font-stretch:normal;font-size:4.01455px;font-family:sans-serif;-inkscape-font-specification:'sans-serif, Normal';font-variant-ligatures:normal;font-variant-caps:normal;font-variant-numeric:normal;font-feature-settings:normal;text-align:center;writing-mode:lr-tb;text-anchor:middle;stroke-width:0.100363">%.1f</tspan></text>
    <text
       xml:space="preserve"
       style="font-style:normal;font-weight:normal;font-size:5.62318px;line-height:1.25;font-family:sans-serif;letter-spacing:0px;word-spacing:0px;fill:#0000ff;fill-opacity:1;stroke:none;stroke-width:0.140579"
       x="13.312727"
       y="72.622002"
       id="text8053-5-6-75-0"
       inkscape:label="{&quot;align&quot;:&quot;Right&quot;,&quot;attr&quot;:&quot;get&quot;,&quot;tag&quot;:&quot;!TAG @1&quot;,&quot;type&quot;:&quot;Good&quot;}"><tspan
         sodipodi:role="line"
         id="tspan8051-8-1-2-9"
         x="13.312727"
         y="72.622002"
         style="fill:#0000ff;stroke-width:0.140579">%s</tspan></text>
    <text
       xml:space="preserve"
       style="font-style:normal;font-variant:normal;font-weight:bold;font-stretch:normal;font-size:5.18951px;line-height:1.25;font-family:sans-serif;-inkscape-font-specification:'sans-serif, Bold';font-variant-ligatures:normal;font-variant-caps:normal;font-variant-numeric:normal;font-feature-settings:normal;text-align:start;letter-spacing:0px;word-spacing:0px;writing-mode:lr-tb;text-anchor:start;fill:#000000;fill-opacity:1;stroke:none;stroke-width:0.129736"
       x="9.5817547"
       y="91.995193"
       id="text6842-5-0-8"><tspan
         sodipodi:role="line"
         id="tspan6840-7-0-81"
         x="9.5817547"
         y="91.995193"
         style="font-style:normal;font-variant:normal;font-weight:bold;font-stretch:normal;font-size:5.18951px;font-family:sans-serif;-inkscape-font-specification:'sans-serif, Bold';font-variant-ligatures:normal;font-variant-caps:normal;font-variant-numeric:normal;font-feature-settings:normal;text-align:start;writing-mode:lr-tb;text-anchor:start;stroke-width:0.129736">Text Tab</tspan></text>
    <text
       xml:space="preserve"
       style="font-style:normal;font-weight:normal;font-size:4.40305px;line-height:1.25;font-family:sans-serif;letter-spacing:0px;word-spacing:0px;fill:#0000ff;fill-opacity:1;stroke:none;stroke-width:0.110076"
       x="13.577642"
       y="104.8528"
       id="text8053-5-6-7-7"
       inkscape:label="{&quot;attr&quot;:&quot;text&quot;,&quot;map&quot;:[&quot;-999999999=Less than zero&quot;,&quot;0=Greater than zero, less than 100&quot;,&quot;100=More than a hundred&quot;],&quot;tag&quot;:&quot;@1&quot;}"><tspan
         sodipodi:role="line"
         id="tspan8051-8-1-4-2"
         x="13.577642"
         y="104.8528"
         style="fill:#0000ff;stroke-width:0.110076">text</tspan></text>
    <text
       xml:space="preserve"
       style="font-style:normal;font-weight:normal;font-size:5.62318px;line-height:1.25;font-family:sans-serif;letter-spacing:0px;word-spacing:0px;fill:#0000ff;fill-opacity:1;stroke:none;stroke-width:0.140579"
       x="90.162704"
       y="61.798027"
       id="text8053-5-6-7-8-3"
       inkscape:label="{&quot;align&quot;:&quot;Right&quot;,&quot;attr&quot;:&quot;get&quot;,&quot;tag&quot;:&quot;@1&quot;,&quot;type&quot;:&quot;Good&quot;}"><tspan
         sodipodi:role="line"
         id="tspan8051-8-1-4-0-1"
         x="90.162704"
         y="61.798027"
         style="fill:#0000ff;stroke-width:0.140579">,.3s</tspan></text>
    <text
       xml:space="preserve"
       style="font-style:normal;font-variant:normal;font-weight:normal;font-stretch:normal;font-size:2.77444px;line-height:1.25;font-family:sans-serif;-inkscape-font-specification:'sans-serif, Normal';font-variant-ligatures:normal;font-variant-caps:normal;font-variant-numeric:normal;font-feature-settings:normal;text-align:center;letter-spacing:0px;word-spacing:0px;writing-mode:lr-tb;text-anchor:middle;fill:#000000;fill-opacity:1;stroke:none;stroke-width:0.0693603"
       x="86.537048"
       y="15.018414"
       id="text7530"><tspan
         sodipodi:role="line"
         x="86.537048"
         y="15.018414"
         id="tspan7532"
         style="font-style:normal;font-variant:normal;font-weight:normal;font-stretch:normal;font-size:2.77444px;font-family:sans-serif;-inkscape-font-specification:'sans-serif, Normal';font-variant-ligatures:normal;font-variant-caps:normal;font-variant-numeric:normal;font-feature-settings:normal;text-align:center;writing-mode:lr-tb;text-anchor:middle;stroke-width:0.0693603">To edit SCADA animations for an object, right-click the object and select &quot;Object Properties&quot;</tspan></text>
    <text
       xml:space="preserve"
       style="font-style:normal;font-weight:normal;font-size:2.7744px;line-height:1.25;font-family:sans-serif;letter-spacing:0px;word-spacing:0px;fill:#000000;fill-opacity:1;stroke:none;stroke-width:0.0693603"
       x="9.4445095"
       y="29.34486"
       id="text7530-3"><tspan
         sodipodi:role="line"
         x="9.4445095"
         y="29.34486"
         id="tspan7532-4"
         style="stroke-width:0.0693603">Use the get tab to retrive and show formatted values of tags (available only for text objects).</tspan></text>
    <text
       xml:space="preserve"
       style="font-style:normal;font-weight:normal;font-size:2.52271px;line-height:1.25;font-family:sans-serif;letter-spacing:0px;word-spacing:0px;fill:#000000;fill-opacity:1;stroke:none;stroke-width:0.0630672"
       x="50.77467"
       y="17.647392"
       id="text7558"><tspan
         sodipodi:role="line"
         id="tspan7556"
         x="50.77467"
         y="17.647392"
         style="stroke-width:0.0630672">https://scadavis.io/scadaviseditor.docx.html</tspan></text>
    <text
       xml:space="preserve"
       style="font-style:normal;font-weight:normal;font-size:2.7744px;line-height:1.25;font-family:sans-serif;letter-spacing:0px;word-spacing:0px;fill:#000000;fill-opacity:1;stroke:none;stroke-width:0.0693603"
       x="9.4445095"
       y="96.387558"
       id="text7530-3-4"><tspan
         sodipodi:role="line"
         x="9.4445095"
         y="96.387558"
         id="tspan7532-4-6"
         style="stroke-width:0.0693603">Use the text tab to display predefined texts associated with ranges of values (available only for text objects).</tspan></text>
    <text
       xml:space="preserve"
       style="font-style:normal;font-weight:normal;font-size:2.7744px;line-height:1.25;font-family:sans-serif;letter-spacing:0px;word-spacing:0px;fill:#000000;fill-opacity:1;stroke:none;stroke-width:0.0693603"
       x="9.5298481"
       y="127.79514"
       id="text7530-3-4-6"><tspan
         sodipodi:role="line"
         x="9.5298481"
         y="127.79514"
         id="tspan7532-4-6-5"
         style="stroke-width:0.0693603">Change color and other attributes of objects based on value ranges. Can trigger scripts also.</tspan></text>
    <path
       style="fill:#dde9af;fill-opacity:0.980392;stroke:#44aa00;stroke-width:0.156404px;stroke-linecap:butt;stroke-linejoin:miter;stroke-opacity:1"
       d="M 7.0277405,85.096626 H 164.0533 l -0.31322,-0.443052"
       id="path7604"
       inkscape:connector-curvature="0"
       sodipodi:nodetypes="ccc" />
    <path
       style="fill:#dde9af;fill-opacity:0.980392;stroke:#44aa00;stroke-width:0.156404px;stroke-linecap:butt;stroke-linejoin:miter;stroke-opacity:1"
       d="M 7.1273985,116.6605 H 164.15294 v -0.44305"
       id="path7604-9"
       inkscape:connector-curvature="0" />
    <text
       xml:space="preserve"
       style="font-style:normal;font-weight:normal;font-size:5.62318px;line-height:1.25;font-family:sans-serif;letter-spacing:0px;word-spacing:0px;fill:#0000ff;fill-opacity:1;stroke:none;stroke-width:0.140579"
       x="38.849468"
       y="163.4511"
       id="text8053-5-6-4"
       inkscape:label="{&quot;attr&quot;:&quot;color&quot;,&quot;list&quot;:[{&quot;data&quot;:&quot;-99999&quot;,&quot;param&quot;:&quot;green|none&quot;,&quot;tag&quot;:&quot;@1&quot;},{&quot;data&quot;:&quot;0&quot;,&quot;param&quot;:&quot;#00ff00|&quot;,&quot;tag&quot;:&quot;@1&quot;},{&quot;data&quot;:&quot;200&quot;,&quot;param&quot;:&quot;none|red&quot;,&quot;tag&quot;:&quot;@1&quot;}]},{&quot;align&quot;:&quot;Right&quot;,&quot;attr&quot;:&quot;get&quot;,&quot;tag&quot;:&quot;@1&quot;,&quot;type&quot;:&quot;Good&quot;}"><tspan
         sodipodi:role="line"
         id="tspan8051-8-1-5"
         x="38.849468"
         y="163.4511"
         style="stroke-width:0.140579">%08.2f</tspan></text>
  </g>
</svg>
```