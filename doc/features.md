# Map features

What the page shows and how it is used: the heat and the other layers, the
controls, the filters, the links that share a view, and what the generator works
out on its own.

## Heat and layers

The Layers group holds the heatmap first, then what is drawn over or instead of
it.

### Heatmap

The Heatmap switch shows where the time was spent: every logged position counts
for the seconds until the next one, so a flight logged every 2 seconds weighs as
much as one logged every 5. Its brightness follows what it draws: the busiest
routes and circuits of a year, of one aircraft or of a shared flight come out
alike, and a logbook of many years does not wash out to white. The busiest
places are rolled off before they are coloured, so a home field flown hundreds
of times keeps its circuit, final and runway apart in the lightest colours
rather than burning out into one white shape, while a route flown once to a few
times gets the most steps of blue. Over a region the heat narrows to the tracks
rather than a haze, and while it is drawn the base map's place and region names
step back a little on a dark outline, so they stay legible without breaking it
up. The wide grey band along country borders is drawn faintly, so it does not
read as a flight. It stays on over a few towns around a field, its tracks a
little wider there so they stay lines, and zoomed in from `z` 12 to 13.75 (the
`z` of a [shared link](#shareable-urls)) it hands over to heat lines: the tracks
themselves, coloured and widened by the time spent on each 40 m of them, so the
taxiways and circuits of a busy airport stay apart.

Its legend is one short row, "Time spent", less on the left and more on the
right; pointing at it says how many passes of a flight the two ends stand for
(about 1 and 64, as the brightness follows the flights drawn), and so does a
screen reader.

In the 3D view the heat is a cloud in the air instead: every flight glows where
it flew, at its height as the 3D view draws it, along the same curve as its
ribbon, and brighter the more time was spent there; from `z` 10.5 in the glow
narrows to a crisp line along each track, so the roads and place names stay
readable, and close in it follows the taxiways and the corners of a circuit as
the heat lines do. A route flown once is a faint blue, the circuits and the
climbs out of a busy field glow white, and a ridge in front of a flight hides
its glow. Where so many flights overlap that more than a hundredth of the cloud
would glow past white, the whole cloud is drawn darker; it is never drawn
brighter, and its busiest places are rolled off as the heatmap's are. It fades
with the distance from the camera, into a haze towards the horizon of a tilted
map, and the tracks nearest the camera stay narrow.

A faint copy of the glow on the ground under the flights shows how high they
were, and pulses run along every track the way it was flown, for 8 seconds after
the map was last used and not at all with reduced motion. Whenever they do not
run (with reduced motion, on a map at rest, in an exported image and during a
replay), faint chevrons along the tracks point the way they were flown instead,
at the same places for every flight along a track, and only where most of the
time there was flown one way: a runway or a circuit flown both ways, or a route
flown out and back, shows none. They fade out from `z` 10 to `z` 8.5, where the
routes of a region run together.

The cloud follows the same switch, filters and share mode as the heatmap, and
steps back under the Aviation layer and the lines of a selection as it does, but
not under the ribbons of a colour layer, which are drawn in front of it; during
a replay it stays at a quarter of its strength and without its pulses, so the
chase view flies through the flights of before, and the Heatmap switch shows as
on. Hovering and clicking still go to the flights, and resting the pointer on
the cloud tells what it is made of as well (see
[Heat cloud readout](#heat-cloud-readout) below). Should the browser not run its
shaders, the flat heatmap stays until the browser gives the map a new WebGL
context.

### Altitude and Groundspeed

The Altitude switch colours the paths by elevation, on a scale that runs purple
through magenta to orange, and the Groundspeed switch colours them by
groundspeed, on a scale that runs blue through green to yellow. The two scales
share no hue, so a map or an exported image says which of them is drawn without
its legend; both brighten from end to end, so they survive being printed in
grey. Both colour layers draw 32 steps of their scale, one line per run of a
path in the same step, and draw every recorded point, joined by a smooth curve
through the fixes. The colours are spread by rank rather than evenly over the
values: every stretch of a scale colours as much of the flying as any other, so
the climb-out, the cruise and the taxiing each get colours of their own, and the
middle of the legend names the median. The altitude scale runs from the lowest
to the highest altitude drawn; the speed scale spans the middle nine tenths of
the speeds drawn (from the 5th to the 95th percentile), and the slower and
faster ones take the colours of its ends, which the legend marks with ≤ and ≥.
Each label of the legend gives the value in both units, feet or knots over
metres or km/h, and the two legends are as wide, so the box keeps its width as
one takes the other's place. A selection and a replay are coloured on their own
flights. Hovering a path shows the exact value.

### Airports

The Airports switch shows the airport markers with their ICAO codes. Each code
sits on a chip at the end of a short stem from its dot, above it where there is
room, otherwise wherever round the dot there is, and where the airports crowd,
further out on a longer stem, a leader line that says whose code it is. Codes
never cover one another, another dot or another stem, nor the panels over the
map, nor the square round another airport's dot that takes a press for it; the
home base and then the busier airports choose first, and a code is only left out
where nothing round its dot is free. Placed on the screen as the map is drawn,
this holds on a turned or tilted map and on the globe alike. While the map moves
a code keeps its place as long as that stays free and glides round its dot when
it has to move; at rest the codes take their best places again, so a code pushed
aside comes back above its dot. The place names of the base map give way to the
codes and their dots, once the map is at rest; on a tilted map the room kept for
a dot shrinks and grows a few pixels with the distance. On a tilted map (the 3D
view) the codes are pins: drawn smaller the farther they are and larger the
nearer, as the map draws its labels (never smaller than 0.7 of their size nor
than 9 pixels of text, and on a phone never smaller at all), and standing
straight up from their dots, on a taller stem where it is crowded, before they
turn aside. An airport the relief hides from the camera fades out, its code with
it. Wrapped's overview draws them flat. A click or a tap on a code opens its
airport, as on the dot, and the airport's popup opens clear of its code. Each
airport is one target for the pointer and the keyboard, and no two overlap: the
24 pixel square round its dot where that lies clear of the squares of the
airports placed before it, otherwise its code's chip (taking a press in at least
24 by 24 pixels round the code it draws), which then takes the focus and the
airport's name while the dot takes no press of its own. Only an airport whose
code has no room either gets a square smaller than 24 pixels, as large as its
neighbours leave. Airports under a panel, and the replay's airplane, are kept
the same way: a marker under a panel takes no press and no focus, and the
airplane's square comes first. The codes are left out below `z` 5 on the map
(Wrapped's overview shows them as long as it shows the markers), and on a map
tilted past about 55 degrees the airports more than twice as far from the camera
as the middle of the map are hidden, markers and codes, where they would crowd
into a strip along the horizon. Below `z` 3 the markers are hidden too, a clump
of dots on the heat.

### Aviation

The Aviation switch overlays airspaces, airports, navaids, and reporting points
from open flightmaps, where it has coverage. It is drawn from `z` 7 to 14; its
charts end at `z` 12, and further in than two levels of upscaling they would
only blur the base map. The start view is further out than `z` 7, so its label
says the charts show once zoomed in.

## Controls

### Search

Find an airport or a place and take the map there: **Search** at the top of the
View group, `/` anywhere but in a text field or a dropdown (a checkbox or a
slider is none) or an open sheet or dialog, or the Search row of the More sheet
on a phone. The field lists the airports of this map first, found as you type by
their ICAO code, name or country (without regard to case or accents), and then
the places Photon finds in OpenStreetMap, each with a short line under it (the
country, or the kind of place and its region). Places are searched from three
characters on, once you pause typing or press Enter with nothing listed, and the
answers to the last 50 texts are kept for the visit, so none of them is asked
again; the line under the list says while it searches, when nothing was found,
and when Photon cannot be reached, takes longer than 10 seconds or the browser
is offline, where the airports are still found. Photon is asked for what you
type and nothing else (see [Privacy](privacy.md#requests-to-other-servers)); the
panel credits it and OpenStreetMap.

The arrow keys move through the list, Enter takes the option they are on, or the
first one, and Escape, a press beside the panel or Tab out of it closes it. An
airport is flown to and its popup opens, as a click on its marker opens it but
without selecting its flights, with the keyboard's focus on its marker; where
the marker is not shown (the Airports switch is off, or the filter leaves it
out) a pulse marks it instead. A place is fitted to its extent where Photon
gives one, at a zoom for its kind otherwise, and marked with a pulse until the
next pick or Escape. The map keeps its bearing and tilt, frames the place clear
of the panels over it, and jumps rather than flies under reduced motion. Replay,
Replay all, the hotspot tour and Wrapped hold the search while they run, and
close it as they start.

### Your flights

See your own flights on any Flown site, without a build of your own and without
sending them anywhere: **Your flights** under Search in the View group, or the
row of the More sheet on a phone, opens a panel that takes the KML or KMZ files
of your flights (SkyDemon, Charterware and the other formats the site build
takes, named as [the naming convention](usage.md#kml-file-naming-convention)
says, since the aircraft comes from the name and the year from the times in the
file, and an `aircraft.json` next to them for the model names), dropped on it,
on the map anywhere (not while Wrapped is open, which says to close it first),
or chosen with the file picker. A folder dropped gives the KML and KMZ files in
it, however deep, but not those in its `.git`, which the site build leaves out
too; of files of one name in different folders the first is kept, and the panel
says so. A file dropped again as it is kept, of the same name, size and time, is
neither stored nor built again: a folder dropped again after a flight was added
to it builds only once, for the new file, and a drop of nothing new shows the
flights kept. Every `aircraft.json` dropped is kept, numbered on from those kept
(`aircraft-2.json` and so on), and the build merges them, the entries of the one
dropped last first, and of one drop those of the folder nearest the flights, as
the site build does; one with the same contents as one kept is that file dropped
again, and stays as it is. The AppleDouble files macOS writes beside a file
(`._1_x.kml`) are left out, dropped or picked, as the site build leaves them
out. The files kept come to 200 MB at most in all, since every build takes all
of them, and each up to 32 MB, the documents of KMZ files unzipped in both (a
build of more names the files that unzip the most), a third of what the site
build reads: a parse takes some twenty times the size of its file at its peak,
which a phone's tab has not for more, and 32 MB of a track is more than a
hundred hours of fixes once a second. The browser keeps the files, runs the same
build the site was made with on them, in a worker with
[Pyodide](https://pyodide.org) (the Python runtime is fetched from its CDN the
first time, some 10 MB, and the site's own code next to the page), and then
reloads the page on your flights: the heatmap, the flights, the airports, the
statistics, the replays, the profiles and Wrapped all work on them as they do on
the site's. The ground under the flights and the airport names come from the
same hosts the build asks (see [Privacy](privacy.md#requests-to-other-servers));
a build that cannot reach them goes on without the ground, with the airport
names as the files spell them and no landings counted, or with the landings
counted without their runways, and says so once in plain words, trying each
elevation tile once rather than waiting to try it again. The elevation tiles the
build needs, some hundred for a year of flights, are fetched by the worker eight
at a time, without a cookie or the page's address, and decoded as the browser
decodes an image, both for the build to use (the Python build fetched and
decoded one after the other, which took a minute and a half for 105 flights); a
browser whose canvas does not read back the pixels it holds, as one against
fingerprinting may, leaves the decoding to the build. Such a build is offered
again, once the connection may be back: the panel shows **Build again**, and a
toast says what the flights lack as the page starts on them, once a tab; that
build fetches what the last could not (another build waits an hour after a
download of the airport names failed, so a slow line does not wait for it at
every file added). **Without the ground under the flights** builds them without
the elevation tiles, so AWS is not asked for the tiles along them, and the panel
keeps the choice, for every tab of the page: a build on its way, in this tab or
another, stops as the box is ticked and starts again without the tiles, and a
build started after takes the choice too. A file that makes no flight (a route
plan without altitudes, a track without a date) is left out rather than failing
the build: the others are shown, and the list marks that file with the reason. A
file kept that the browser's storage can no longer read fails the build, which
names it to be removed and added again. The panel says the steps of the build as
it goes, and lists the warnings of the build once it is done (a file that names
no aircraft, say), the first ten and what the build went without, and says how
many more there were. A build that is done while the panel is closed, or while a
replay, the tour or Wrapped has the map, does not reload the page under you: a
toast says your flights are ready, with a Show to switch to them; one that fails
then says why in a toast too, with a Show that opens the panel once the map is
free again (the toast stays until then, as Build again's does). Nor does one for
a file removed or the ground switch changed while the site's flights are shown.
**Stop the build** stops one on its way and keeps the files, until it is done
and its dataset is being kept; **Show my flights** builds them again, also where
your flights are shown and the stopped build was of a drop. The next visit then
opens on the flights built before the drop, rather than building the files again
on its own. Removing a file while a build runs stops that build and starts the
one without the file at once.

The panel says which flights the page shows and lists the files kept, each with
its size and a Remove; a file added or removed builds the set again, and so does
**Show my flights** after a file changed. After the site was deployed again,
whose build may write the data files another way, the page opens the panel on
its next visit and builds the files again, saying so, then shows them (a reload
meanwhile goes on with it: the state of the site's flights in the address is the
page's own there, not a link); a rebuild that fails leaves the next visit on the
site's flights, and **Show my flights** tries again. A build that is done while
an older dataset is still shown goes to the new one, whole, as soon as the page
reads a file of it. **Show the site's flights** goes back to the site's without
losing the files, **Show my flights** returns to them, and **Remove all**,
pressed a second time as it asks (for 15 seconds, and for as long as it has the
focus; it says when it stops asking), lets the files, the build and the build's
cache go (the parsed tracks, the elevation tiles along them and the airport
database, which the next build fetches again). Another tab of the page lets them
go, and a build of its says the files were removed in another tab, keeping
nothing it built of them; if that tab's Remove all removed nothing after all,
the build starts again. If a tab does not let go in time (one still on an older
deploy of the site), Remove all says so and removes nothing. Another tab that
shows the flights removed goes to the site's, and lets the view it saved of them
go. A build also lets go of what the cache holds of files removed: their parses,
and, once it gets through, the tiles no flight left needs (all of them without
the ground). Each set of flights keeps a view, year, aircraft and selection of
its own; the switch opens the page afresh. Nothing leaves the browser: the files
and the data built from them stay in its storage (IndexedDB), which goes with
the site's data when the browser clears it; Safari lets go of the storage of a
site not used for a week unless the page is on the home screen. Copy link is
dimmed while they are shown, and the statistics say they were built in this
browser rather than when the site was. Copy link's title says that a link cannot
carry flights that are only in this browser, which a press says as well. A link
opened on a page that shows your flights, someone else's long link or one from
before the short links, opens on the site's flights it is to, also when that tab
is reloaded, and a toast says so, with a **Show my flights** that switches back.
While your flights are shown the page keeps no state in its address (their
registrations and flight ids would stay in the history and a browser's sync); a
reload opens on them with the view saved in the browser. Replay, Replay all and
the hotspot tour hold Your flights while they run, as they hold the search.
Escape closes the panel, wherever the focus is, but in a text field or a
dropdown outside it (the search of the flights, the year), whose Escape is its
own.

### Statistics

View statistics (distance, altitude, landings, airports, flight time). A line at
the top says what they are of: the year and the aircraft of the filter ("2026 ·
All aircraft"), or the selected flights. Flight time runs from the first to the
last recorded point that moved at the exported precision (about 1 m), so
standing perfectly still before and after is not counted, while GPS noise on the
ground still is.

The panel's Flights tab lists every flight of the year and aircraft filter with
its route, aircraft, year, flight time, distance, highest altitude and full-stop
landings (a year, never a date; the year column only while all years are shown);
each row's checkbox is named after the flight with its distance, so flights of
one route tell apart; the landings cell names the touch-and-goes as well when
the pointer rests on it, and flights without timestamps have no landings. The
rows start in the order of the flight files; a column header sorts by it, up,
down and back. The search keeps the flights whose airports (code or name),
registration or type match every word typed. A click on a row selects that
flight alone; its checkbox, or a click with Ctrl or Cmd held, adds it to the
selection or takes it out, which is also how a phone puts several flights
together. Shift sets every flight from the row clicked last in that list to this
one, in the order the list shows, to what this row's checkbox goes to: in, or
out where it was ticked. A sort, a search or a closed list starts the range
afresh. In share mode only the checkbox adds or removes a flight (with Shift for
a range): a click on the rest of a row brings a shared flight into view, and
says how to add one that is not shared. During a replay or the hotspot tour the
selection stays as it is. A flight picked alone, here or from an airport's
popup, is brought into view clear of the panels and of its altitude profile,
unless all of it is in view already, the map was moved meanwhile, or the hotspot
tour or Wrapped has it; a flight in view that spans less than a quarter of the
map between the panels either way, such as a circuit round the home field, is
framed as well, no closer than a replay follows a flight. A click on a flight on
the map leaves the map where it is. The arrow keys move between the two tabs. On
a phone the same tabs are inside the statistics sheet, which Escape closes as
well as its tab (not an Escape for a popup, a marker, the readout of the heat
cloud or the search of the flights); a flight picked alone there, or from an
airport's popup, closes the sheet and the popup, which stood over the map it is
shown on.

### Export image

Save the current map view as a JPG image. To print the map, export it as an
image first: the browser's print dialog cannot capture the WebGL map.

### Copy link

Copy a link to the current view to the clipboard. On a phone, where there is a
native share dialog, the More sheet's row says **Share link** and opens that
instead. The link packs the whole view into one short token (see
[Shared links](#shared-links)); the address bar keeps the readable link.

### Wrapped

View the year-in-review summary; Escape closes it. Opened from its button for
the first time in a session for that year, it starts with the map filling the
dialog and the title of the year over the globe, and, in an intro of about ten
seconds, a flight down towards your home base, two zoom levels closer than the
overview, so the routes of the year show around it, over the heat cloud of the
year (every flight the year and aircraft filters keep, at full strength,
whatever the Heatmap switch, share mode or a colour layer say), while the
flights of the summary play underneath at 300x, as in Replay all (at their
height in the heat) but drawn larger; then the cloud fades into the heatmap,
back on the map's own projection, and it settles on the overview as the cards
come in one after another and the map draws back into its panel beside them
(below 1024 px wide, where the cards are stacked, it fades from over them
instead); Skip intro, or a press, wheel or key on the map, goes straight to the
summary, and the flight does not play while the system asks for reduced motion.
Opened again for the same year in the same tab, it goes straight to the summary.

Beside the map the cards scroll in a column of their own, each as tall as its
content, and **More below** at the foot of the first takes the column to the
next card while there is more below. Resting the pointer on a destination flies
the map there, and leaving the list flies it back. For a year it names the new
airspace, the square kilometres its flights passed over and no flight of an
earlier year did, once the page holds the earlier years (after the view of all
years or each earlier year was shown); it does not load them itself.

### Replay

Animate the selected flights with adjustable speed (1x to 1000x, default 50x)
and an auto-zoom button that follows the airplane; Escape closes it. The whole
track is drawn dimmed and the flown part paints over it in the colours of the
active scale. Replay needs a selected flight with timing data; a toast explains
why it is unavailable otherwise, and with nothing selected the Flights tab of
the statistics opens to pick one from; in share mode, where the filter hides
every shared flight, it says they are hidden by the filter. A replay and Replay
all put away a flight's or an airport's popup left open as they start. With more
than eight selected, such as all of an airport's, it is unavailable and says
that Replay all plays more. A flight is picked on the map only where it is
drawn, with Altitude or Groundspeed on.

With two to eight selected, the same panel plays them one after another, for a
look at a day of several: in the order of their files (by year, then as the
files were read), on one clock. The airplane lands, waits there for a minute of
the clock (a second at 60x) and appears at the first fix of the next flight;
never the time on the ground between them, nor a date or an hour. The time reads
which flight flies and how far into it ("2 of 3, EDDS → EDTF: 0:42 in"), as wide
as that of the flight with the longest route so the panel keeps its width, and
the live region says each flight as it starts, even at 1000x. The timeline runs
over all of them: the altitude profile, as for one flight, where it is shown,
and otherwise the slider, with each flight's part of its track drawn and the
pauses left out. The trails of the flights before stay, the route of each is
drawn dimmed on its own, and the trail is coloured on the ranges of all of them.
Auto-zoom moves the view over to the start of each flight, and without it the
view moves only where the start is off the map; the chase view flies over on its
own. Selected flights without timing data are left out, and a toast says how
many.

The chase button (the target next to auto-zoom) watches the flight from a chase
plane: the camera sits behind and above the airplane, tilted to 70 degrees at
about `z` 15.5, and turns with it, lagging a little into each turn. The airplane
stands upright, a little below the middle of the map above the replay panel. In
the 3D view the camera looks at the airplane at its height and tilts down
steeper rather than fly into a ridge behind it. Switching it on slows a replay
faster than 10x down to 10x, and switching it off brings back the speed from
before, unless another one was chosen while it chased. Dragging, zooming or
turning the map holds the chase until you let go, and the chase keeps the zoom
(`z` 12 to 17) and tilt (45 to 75 degrees) you left it at. On the globe it zooms
out no further than `z` 13, where the globe is still drawn flat. Switching it
off gives back your zoom, turn and tilt over the airplane, and closing the
replay gives back the whole view from before; the link and the saved session
keep that view, not the chase camera. It stays off while the system asks for
reduced motion, and a toast says why.

### Replay all

Play every flight the filters and share mode keep at once, each from its own
first fix, at 100x to 1000x (default 200x): each flight is a bright head with a
trail that fades behind it (over at most 25 minutes of flight), at its height as
in the 3D view, on the flat map as well. The trails glow in the colours of the
Altitude or Groundspeed layer when one is on as the replay opens, on the range
its legend shows (the selection's, where there is one), and amber otherwise;
like the Groundspeed layer, a trail draws nothing where the aircraft stands
still. Behind the heads the heat builds up as far as they have flown, in the
heatmap's colours, and ends as the whole heat of the flights; it is the heat
cloud's glow at the height of the flights, with its shadow on the ground, and
none is drawn while the Heatmap switch is off.

The clock reads the time into every flight ("0:42 into every flight"), never a
date or an hour, and the slider beside it moves along the same clock: drag it
(the replay holds while you drag and plays on as you let go), click it to jump,
backwards as well, or use the arrow keys for a minute at a time and Home and End
for either end. A flight without times takes its length at its groundspeed, and
one with neither sits out.

The map fits the flights north up, as large as the map allows clear of the
controls and the panel, and a flat map is tilted as the 3D view tilts it, so the
heights show, and laid flat again as it ends unless you tilted it yourself or
turned the 3D view on meanwhile (the link and the saved session keep the tilt
from before); the orbit button turns it slowly round them until you move the
map, and stays off while the system asks for reduced motion, and a toast says
why. The filters, the selection, the layers and Wrapped are held while it plays,
as during a replay, and come back as they were; their titles say to end the
replay to change them. Escape or the close button ends it. On a phone it is in
the More sheet, and its panel is laid out like the replay's: the clock on a line
of its own, the close button in the corner and the controls in one row, the
slider between play and the speed.

### Hotspot tour

Fly over the busiest places of what the heatmap shows, in the 3D view with the
heat cloud: up to five places, where the heat of the flights the filters and
share mode keep is strongest (weighed as the heatmap is, and the neighbouring
cells of a place taken together, at least 8 km apart). Each is named after its
airport ("Home field EDAQ Halle-Oppin" for the home base), or by its distance
and direction from the nearest one ("18 km south-east of EDAQ Halle-Oppin"), and
captioned with the time spent there ("4 h 58 min") and its share of the view's
time; never a date or an hour. The camera flies to each place, tilted, and turns
slowly over it for a few seconds before it moves on.

Pause, the previous and the next place and Stop are in its panel, and the
caption is read out as it changes. Played to the end, stopped or ended with
Escape, it flies back to the view it started from and turns the 3D view and the
heatmap back to what they were; a press, a wheel or a key on the map ends it
where it is instead, in the 3D view, for you to look round from there. While the
system asks for reduced motion it cuts to each place and waits for the next or
previous button. The filters, the selection, Replay, Replay all, Wrapped and the
Cross-section are held while it runs (an open cross-section closes as it
starts), and it does not start during a replay. On a phone it is in the More
sheet, and its panel takes the bottom edge while the bar of tabs steps aside, as
for a replay. Next and the previous place while it is paused fly there and wait,
and the relief and the cloud follow the view they arrive at.

### Altitude profile

With a flight selected, a strip at the bottom of the map draws its altitude over
time (over the distance flown for a flight without times), with the ground
filled in underneath, and the highest altitude, the lowest height above the
ground en route and the time spent below 1,000 ft above it en route ("5 min", "1
h 12 min", never a clock that reads as hours); en route leaves out 2 km around
each airfield. Pointing at the chart reads out the values there and marks the
place on the map, and pointing at the flight on the map moves the chart's
cursor. A click or a drag on it (a tap on a phone) opens the replay paused at
that moment; during a replay the chart is its timeline, and during the replay of
all flights it is put away. The button with the mountain on the selection chip
puts it away and brings it back, and the browser remembers which.

With two to eight flights selected, it draws them one after another in the order
of their files, each named by its route over its part of the chart ("EDDS →
EDTF") and parted from the next by a dashed line and a narrow gap of the same
width each time, never the time on the ground; it runs over the distance flown
unless every one of them has times, and ends with how many flights it shows. The
figures are those of all of them, the readout gives the time into the flight
pointed at (a point in a gap reads the nearer end of a flight), and a click on
one with times opens the replay of them one after another (see
[Replay](#replay)), paused at that moment, also where the chart runs over the
distance; during it the cursor follows the flight in the air; the pointer turns
into a hand over those, and a click on one without times says it has no timing
data. Where only one of them has a profile, it is drawn as a single flight. More
than eight have no profile.

### Cross-section

Draw a line on the map and see, side on, where the time was spent within a
corridor either side of it: the distance along the line across, the height up,
as a density image in the heatmap's colours and weighed like it (the seconds
each stretch of a flight took, at most two minutes). Click or tap its two ends,
or drag it; from the keyboard, "Set A at the map centre" and then B place them
where the middle of the map is, so move the map between the two. Escape takes
back a point being placed, or the line being redrawn, and otherwise closes it.
The ends (A and B) can be dragged afterwards, or moved with the arrow keys once
focused (Shift for bigger steps), and the ruler button draws a new line.

The corridor is drawn on the map while it is open. It is 250 m, 500 m, 1, 2 or 5
km either side, picked for the zoom as the line is drawn (about 40 px on the
screen, 500 m over a traffic circuit) and then from its list. Heights are above
the ground under each fix (AGL; above the field for a flight without terrain) or
above sea level (MSL), which draws the ground under the flights beneath them;
the chart reaches up to where all but half a per cent of the time was spent, and
says how much was higher up. It counts the flights of the year and aircraft
filters, and while flights are selected only those, so a click on a flight shows
it alone. The line is in the link and the saved session (see
[Shareable URLs](#shareable-urls)), and a page opened with it opens the tool on
that line; the width of the corridor and the choice of AGL or MSL are in
neither, so the tool picks the width for the zoom again and starts with heights
above the ground.

The figures give the time, the number of flights and the band of height the most
time in the air was spent in; pointing at the chart (or a finger on it) reads
out the distance, the band of height and the time of the cells there, and marks
the place on the line on the map. The chart's summary is its accessible name and
is announced as the line comes to rest; no date or time of day is shown. It
takes the place of the altitude profile at the bottom of the map while it is
open, and replay, Replay all, Wrapped and the hotspot tour close it. On a phone
it is in the More sheet.

### North up

The map turns and tilts (up to 85 degrees, with a sky above the horizon) by
gesture: drag with the right mouse button or with Ctrl held, twist or drag with
two fingers, or hold Shift with the arrow keys once the map has focus. The
needle on this button points north, and a click turns the map back north up and
flat. On a phone the compass floats at the top right of the map while the map is
turned or tilted, and the globe switch is in the Layers sheet. Replay keeps the
orientation you chose and points the airplane along its track on screen; Wrapped
shows its overview north up and flat and gives your view back when it closes.
While the map is already north up and flat the button is dimmed and does
nothing.

### Globe

Draw the map as a globe instead of in Mercator. From `z` 13 in the two look the
same, which is MapLibre's doing. Airport markers on the far side are hidden, and
a popup closes once the globe has turned its place away. The space around the
globe is the page background; no atmosphere is drawn.

### 3D

Lift the flights to their altitude, as ribbons about as wide as the lines at
every zoom that follow their climbs and descents in 20 ft steps close in (in
steps of no more than a pixel further out) and stand on the ground each flight
flew over: the build samples it under every logged position from an elevation
model (see [Elevation data](output.md#elevation-data)) and shifts it to meet the
altitudes the flight recorded taxiing at the field it left and at the one it
landed on, so a flight taxis on the map at both ends even where the model and
the recorder disagree by tens of feet, and crosses a ridge at its true height
above it. A flight whose ground is not known (a build with `--no-terrain` or
without the tiles) stands on a line from the one field to the other instead, and
an altitude glitch of the recorder takes no flight up with either.

Heights are exaggerated, and the relief under them as much, so a flight still
shows its shape on a map of half of Europe: 10 times at `z` 8 and further out, 7
at `z` 9, 4 at `z` 10 and twice from `z` 11 in.

Switching it on leaves the Heatmap, Altitude and Groundspeed layers as they are
(the heatmap is lifted as a cloud, the colour layers as ribbons), colours the
paths by altitude only when all three are off, where nothing would be lifted,
and tilts a flatter map to 50 degrees. Tilting the flat map does not turn it on;
the first time in a visit that you tilt it past 30 degrees yourself, a hint
offers the 3D view with a **3D** button (not while a replay, Wrapped or the
hotspot tour runs, nor once you switched 3D on or off). On a touch screen, where
a tilt is a small two-finger drag, 15 degrees are enough, and the same hint
comes once on the device without a tilt as well: the first time you zoom in by
hand past where the heat lines are drawn (`z` 12.75), as the map comes to rest,
or pick a single flight (not an airport's, nor one ticked in an airport's popup
or the phone's statistics sheet, which the hint would cover), whichever comes
first. That one goes by itself after eight seconds, or as soon as you move the
map, but not while the focus is on its buttons. The browser remembers that it
showed the hint, or that you switched 3D on or off yourself, in its
localStorage; where it cannot keep it, the hint comes once a visit. The hotspot
tour, which turns 3D on for its flight, or a link that opens in 3D leave the
hint for later. From `z` 18 in, where the camera is lower than a traffic
circuit, the flights are drawn flat again. Replay lifts its airplane and its
trail with them. The heatmap turns into a cloud of the flights at their heights
(see [Heatmap](#heatmap) above), on the relief and on the globe alike, and lies
flat from `z` 18 in with the flights.

At every zoom the map draws the relief under the flights, shaded faintly (dark
slopes, a little light on the others) over the satellite imagery when it is on
and under the labels and the flights, and each flight stands on it at its height
above the ground it flew over. Further out the map draws the relief from coarser
elevation tiles, and the ground under the flights is smoothed as much, so a
level flight stays level over the ridges to within about a pixel; the
exaggeration stops at 10 times since further out the Alps stood as a wall and a
flight over them sawed up and down. While a zoom goes on, and in the distance of
a tilted map, the map draws parts of the relief from the elevation tiles of
another level, and each flight stands on the ground of the level drawn under it,
so it stays level over the ridges there too. The exaggeration of the relief and
the flights changes as a zoom ends in another level, not during it, for both at
once, and the flights stay in sight. The relief comes from the same elevation
tiles as the ground (see [Elevation data](output.md#elevation-data)), which the
browser fetches from AWS while it is drawn. The globe only shades it: the relief
itself is left out there, and each flight stands on the line between its fields.

As the relief comes or goes, and as a zoom ends in another exaggeration while
the map still draws flights cut at `z` 7 or further out or at `z` 12 or further
in (after a zoom across more than one level from there, or another zoom before
those flights were drawn anew), the flights are hidden until they are drawn on
the new ground, for 3 seconds at most (a playing replay's trail, drawn anew in
every frame, is not waited for). Tilted past 45 degrees, the map leaves out the
place names of its far distance, which stood along the horizon over the fog.

### Heat cloud readout

In the 3D view, resting the pointer on the heat cloud, or tapping it on a phone,
shows a small box beside it with what the cloud there is made of: the time spent
within a round radius about as wide as the glow (from 100 m to 50 km, by zoom),
the number of flights that came that close, and the 400 ft band of height above
the ground most of it was in, for example "About 42 min within 1 km" over "17
flights · mostly 800 to 1,200 ft AGL". It is counted as the cloud counts it (the
seconds between the logged positions, at most two minutes each; a track without
times at a cruise), and never from the brightness, which the cloud scales to its
busiest places; it follows the filters and share mode, and says no date or time
of day.

There is none over the sky of a steeply tilted map, or beside the globe. In a
tilted view it counts every flight the line of sight through the pointer passes
near, at whatever height the cloud draws it, since the glow under the pointer
adds all of them up. Over a flight's ribbon its values show as well, and the box
goes beside them rather than over them, and clear of the panels over the map
where there is room; a tap on a flight shows both. Markers, airport codes and
dragging come first, and Escape puts the box away until the pointer moves on,
before it closes anything else. A click or a tap on the cloud is read out to
screen readers, unless it selected a flight, which is read out instead; a hover
is not. A click there never clears the selection. The flat heatmap has no
readout: its code comes with the 3D view, not with the first visit.

### Satellite

Draw the ground from satellite imagery (Sentinel-2 cloudless 2024 by EOX, see
[Satellite imagery](output.md#satellite-imagery)) instead of the dark map: over
its land and water, under its roads, borders and place names, the flights, the
heatmap and the Aviation overlay, which works over it too. The imagery is
darkened and made paler so the heat, the colour layers and the labels made for
the dark map still read. It is sharp to about `z` 14 and stretched further in,
where the roads and the Aviation layer show the airfields better. In the 3D view
it lies on the relief under the shading. Off on a first visit; kept in the link
and the saved session. The browser fetches the tiles from EOX only while it is
on, and the map credits them only then, in an exported image too. Should its
code fail to load, the switch turns back off and says so. On a phone it is in
the Layers sheet.

### Reset view

Go back to what a first visit shows: the newest year and all aircraft, the
heatmap and airports on and the other layers, 3D, the globe and the satellite
imagery off, nothing selected, the statistics and the cross-section closed, and
the map flat and north up over all the flights. The saved session and the link
follow. While there is nothing to reset, on a first visit and after a reset
until the page or the map changes, it is dimmed and a press says why; in the
phone's More sheet, where it is on a phone, a press does nothing then. During a
replay it is disabled like the filters.

### Across the controls

- A map attribution, on the map at every width; it steps aside only while a
  sheet or the statistics panel covers the map it credits. It wraps when the
  relief, the satellite imagery or the aviation layer add their credits; on a
  phone it shows two lines, and a tap on it shows the rest. There are no zoom
  buttons: use the scroll wheel, pinch, double click, or the keyboard once the
  map has focus
- A toggle that is off is drawn at full strength without the blue accent; only a
  control that cannot act right now (Replay without one timed flight selected,
  Share mode without a selection, North up and Reset view with nothing to reset,
  and what a replay disables, whose title then says to end the replay, the
  replay of all flights or the hotspot tour to change it) is dimmed. While
  Replay, Replay all or the hotspot tour runs, its control is drawn pressed with
  a filled stop square. A control that needs the flights says so with a toast
  while the first year still loads, rather than ignoring the click; a filter
  changed meanwhile is applied once it has loaded
- An error stays on screen until it is dismissed or put right (a later load of
  flights, of Replay's or Wrapped's code or of the satellite imagery, or the map
  drawing after all); a failed load offers Retry, which a running replay
  ignores, and one that asks for a reload (a site published again since the page
  loaded, a map that does not draw or does not start) offers Reload, as an app
  on the home screen has no control of its own for it. When the first year
  cannot be loaded the map says what failed and offers Retry there (Reload,
  where the site was published again since the page loaded), with no toast
  beside it; the year dropdown keeps showing that year (or another one picked
  meanwhile that failed as well), which Retry loads again, the colour legends
  are hidden while there are no flights, Statistics, Wrapped, Replay all, the
  hotspot tour, the cross-section and the export are unavailable and say so (on
  a phone the tabs and the More rows too), and Reset view is available. The
  loading indicator shows from the start, while the list of years loads, and the
  year dropdown names the year the page opens on from the first paint
- Beside the statistics the toasts are centred on the map, clear of the columns.
  They stand over the colour legend in a window narrower than 940 px, or 1284 px
  beside the statistics: the legend steps aside there while one shows
- The controls come before the map in the tab order, and the "Skip to map" link
  at the start of the page goes past them to the map and its airport markers
- Below 768 px, or at 480 px of height and less (a phone held sideways), the two
  control columns are replaced by a bottom bar with five tabs. Layers, Filter
  and More open a sheet; Stats and Wrapped open their panel directly. The Filter
  tab shows the year the map shows ("Filter" for all years). A sheet closes with
  its close button, a tap beside it, or a drag down on its top edge (the grabber
  and the title) past a third of its height or a quick flick; a shorter drag
  lets it spring back, and under reduced motion it closes or returns at once.
  Escape closes an open sheet, and Tab stays inside it. The Layers sheet takes
  half the height, so the map above it shows what a switch did, and scrolls. On
  a phone held sideways the sheets stand at the right edge instead, with the map
  and the toasts beside them. Replay, Replay all and the hotspot tour take over
  the bottom edge and the bar steps aside until they end. The map shows no
  colour legend there, the heat's included; the Layers sheet shows the scales of
  altitude and groundspeed beside their switches
- Added to the home screen, the site opens as an app of its own (the manifest's
  `standalone` display), and on an iPhone the map fills the whole screen, under
  the status bar and around the Dynamic Island or the notch; the controls, the
  sheets, Wrapped, the popups, the map attribution and the first view keep clear
  of them, of the rounded corners and of the home indicator. In a Safari tab the
  strip at the top is Safari's own, and only a phone held sideways shows the map
  around the island

### Units

The page uses aviation units first, distances in nautical miles, groundspeeds in
knots and altitudes in feet, with the metric value beside them where there is
room. A flight's popup gives the altitude (MSL) in feet with metres after it and
the groundspeed in knots with km/h; the statistics rows give nautical miles with
kilometres, feet with metres and knots with km/h beside them; the replay readout
says feet and knots with metres and km/h; and the legends give both (see
[Altitude and Groundspeed](#altitude-and-groundspeed)). The Flights tab of the
statistics lists the distance in nautical miles and the highest altitude in feet
MSL, without the metric value. Distances on the ground are metric: a hotspot is
"18 km south-east of" its airport, the profile of a flight without times runs
over the kilometres flown, and the cross-section measures its corridor in metres
or kilometres either side and the distance along its line in kilometres, with
its heights in feet (AGL, MSL or above the field). Numbers are written the
American way on purpose, with a comma between the thousands ("264,400") and a
point before the decimals, whatever the browser's language, so every surface of
the page groups the digits the same way.

### Keyboard

| Where                                                             | Keys                          | What they do                                                                                                                 |
| ----------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| The map, once it has focus (Tab to it, or the "Skip to map" link) | Arrow keys                    | Pan by 100 px (MapLibre's own keys)                                                                                          |
|                                                                   | Shift + Left or Right         | Turn the map by 15 degrees                                                                                                   |
|                                                                   | Shift + Up or Down            | Tilt it by 10 degrees                                                                                                        |
|                                                                   | + and -                       | Zoom in and out by a level, by two with Shift                                                                                |
| Anywhere but a text field, a sheet or a dialog                    | `/`                           | Opens the search, or goes back to its field while it is open                                                                 |
| The field of the search                                           | Up and Down                   | Move through what was found, round from either end                                                                           |
|                                                                   | Enter                         | Takes the option the arrow keys are on, or the first one; with nothing listed, searches places at once                       |
| Whatever is open                                                  | Escape                        | Closes the innermost thing that is open (see below)                                                                          |
| The Layers, Filter or More sheet on a phone                       | Tab and Shift + Tab           | Move within the sheet and wrap round at its ends; focus stays inside until it closes (the statistics sheet does not hold it) |
| The replay's slider                                               | Right or Up, Left or Down     | A hundredth of the flight on or back, at least one second                                                                    |
|                                                                   | Page Up and Page Down         | A tenth of the flight                                                                                                        |
| The Replay all slider                                             | Arrow keys                    | A minute of the clock                                                                                                        |
|                                                                   | Home and End                  | The start and the end                                                                                                        |
| An end of the cross-section (A or B), once focused                | Arrow keys                    | Move the end by 10 px on the screen, by 50 px with Shift                                                                     |
| The tabs of the statistics panel                                  | Left and Right                | The other tab (Statistics or Flights)                                                                                        |
|                                                                   | Home and End                  | The first and the last tab                                                                                                   |
| A row of the flight list                                          | Click, or Enter on its button | Selects that flight alone; with Ctrl or Cmd held, or on its checkbox, adds it or takes it out; Shift sets a range            |
| An airport marker                                                 | Enter                         | Opens its popup and moves focus into it, where Escape closes it again                                                        |

Escape closes the innermost thing first: the readout of the heat cloud, the
search while focus is in it (and the pulse of its last pick with it), then an
airport's popup while focus is on its marker or inside the popup (focus goes
back to the marker), or the popup of a replay's airplane while focus is on the
airplane (on a marker whose popup is closed, Escape goes on to what comes next),
then a sheet on a phone (the statistics sheet among them, but not while focus is
in the panel of Your flights or the search over it), the panel of Your flights,
a replay, Replay all, the hotspot tour, Wrapped, the cross-section, whose Escape
takes back a point being placed or the line being redrawn before it closes the
tool, or the pulse the search left on the map. The popup of a flight has no
Escape, nor has a replay's with focus elsewhere: its close button or a click on
the map closes it.

The statistics sheet on a phone leaves the map in reach, to touch and to Tab to,
except while it covers all of it: then Tab passes over the map nobody can see.

## Filtering

- **Year filter** - View flights from specific years or all years combined
- **Aircraft filter** - Filter by aircraft registration to see flights per
  aircraft
- **Path selection** - Click paths to highlight and view detailed statistics. A
  mouse click on a flight selects it or takes it out. A tap shows the values of
  the flight with a Select (or Remove) button instead, so that looking at a
  flight on a phone does not change the selection; a touch laptop tells its
  mouse from its screen by each click. A click on the map beside every flight
  closes the popups and leaves the selection alone. A chip at the top of the map
  says how many flights are selected and clears them again (Clear), or puts them
  into share mode (Share); on a phone it also replays the selected flights, up
  to eight, when one of them has timing data, and while the statistics sheet is
  open it moves into the sheet's header without its count. With neither colour
  layer on, the selected flights are drawn as thin light lines over the heatmap,
  which steps back while they show, at every zoom level, and the lines are
  fainter the more flights are selected; in the 3D view they are lifted to their
  height with the heat cloud
- **Airport selection** - With nothing selected, click an airport marker to
  select all flights that visited it; with a selection, in share mode, or with a
  tap, the click only opens its popup, whose checkboxes select (a tap never
  changes the selection). The airport popup shows how the flights of the filter
  used its runways ("RWY 29 · 65%, RWY 11 · 35%") and lists those flights
  (route, aircraft, year and distance), each a button that selects that one
  flight and a checkbox that adds it to the selection or takes it out, with
  Shift, Ctrl and share mode as in the flight list (the rows are marked as
  selected once the selection is not all of them, and a lone flight always), so
  a single flight and Replay are reachable from the keyboard: Tab to a marker,
  Enter opens the popup and moves focus into it, Escape closes it and returns
  focus to the marker
- **Year and aircraft filter with a selection** - A change of the filter keeps
  the selected flights it still shows and deselects the others, which a toast
  says: "1 selected flight is hidden by the filter and was deselected" for one
  the aircraft filter hides, "not in 2024" for one the year's flights lack (one
  year's file cannot tell another year's flight from one the site no longer has,
  and the metadata lists no flights). A dataset of every year leaves out a
  flight the site no longer has ("Left out 1 flight not on this site"). Share
  mode keeps every shared flight instead (see below), and its Exit deselects the
  ones the filter hides as a filter change does
- **Share mode** - For showing a few flights, the two or three of a day, to
  someone else: the map shows only the selected flights, and their heat alone,
  and the selection holds still. Turn it on with Share in the chip or Share mode
  in the Share group (More on a phone); the chip then says "Sharing 3 flights"
  and offers the link (Copy link) and Exit, which leaves the mode and keeps the
  flights selected. On a phone the chip shows share mode's mark and a blue
  border in place of "Sharing", and the link (Share link) and Exit as icons, so
  that it fits a 360 px screen beside Replay; beside the statistics in a window
  narrower than 1280 px, where the columns show their icons alone, it does the
  same, and below 960 px it stands under the filters. While it is on, a click or
  a tap on a flight shows its values with a Remove button, a click on an airport
  opens its popup, and a click on a row of a list shows its flight, but none of
  them adds or removes a flight by itself; a flight joins or leaves with that
  Remove or its checkbox in a list, and the mode ends with Exit or the last
  flight. An airport whose last shared flight is unticked in its popup stays on
  the map until the popup closes. The shared flights are fixed under a change of
  the year or the aircraft as well: the ones the filter hides stay shared and in
  the link, and the chip says so ("Sharing 3 flights, 1 hidden by the filter",
  "3 flights, 1 hidden" on a phone, "all hidden" where it hides every one, "1
  not in 2024" or "none in 2024" for flights the year's file lacks, "1 not
  shown" for both). The map, its lines and ribbons, the airports, the
  statistics, the frame of Share, Replay and the altitude profile are of the
  shared flights the filter shows. A link opened in share mode shows the same
  flights the same way, with the same words for the others. Only a link to every
  year can tell a flight the site no longer has, which it leaves out and says
  so. A link from Copy link (or Share link on a phone) in share mode opens with
  a short intro, once: the camera eases from the link's view to frame the shared
  flights the filter shows while their lines draw in one after another, in the
  order of their files, about five seconds for all of them (each flight takes a
  part by how long it took, and at least 0.6 s so a short hop is seen being
  drawn); a flight without times shows at the end. The camera keeps the tilt and
  the bearing of the link and frames the flights at that tilt as share mode
  does, the lines are drawn as Replay all draws its trails (in the colour
  layer's colours, amber without one), and with the Heatmap on their heat builds
  up behind them, as the cloud of the 3D view on the flat map too, which fades
  into the heatmap at the end. Any key (but Tab or a modifier on its own),
  click, touch or wheel skips to the end, and one before the intro could start
  keeps it from playing; with reduced motion the flights are only framed. A
  reload, a link copied from the address bar and the saved state do not play it
  again (see `i` below). Such a link leaves out the statistics panel the sender
  had open, and opens without it, and while it shares the sender's flights
  nothing is saved for the visitor's next visit, which opens on their own view
  as before

## Shareable URLs

Map state is encoded in the URL for easy sharing (not while
[Your flights](#your-flights) are shown). Copy the URL from your browser's
address bar, or use the copy-link button for a short link to the same view (see
[Shared links](#shared-links)):

- Specific year or all years (`?y=2025` or `?y=all`)
- Aircraft filter (`?a=D-EAGJ`)
- Selected paths (`?p=8vndgpro,1bspfs7g&sv=4`). A path id is derived from the
  flight's coordinates and altitudes, so a link keeps selecting the same flights
  after the site is regenerated with other flights added or removed; a flight
  that is no longer there is dropped from the selection. `sv` is the version of
  the id scheme. Version 4 writes the ids in base 36; version 3 links, which
  wrote the same ids in decimal (`?p=695806902132,104044549516&sv=3`), still
  work. Links written before version 3, when ids were positions in the export,
  lose their selection instead of selecting different flights
- Layer visibility (9 flags: heatmap, altitude, speed, airports, aviation,
  stats, wrapped, an unused legacy slot, isolateSelection). The 8th slot
  belonged to a control-visibility toggle that no longer exists; it is always
  written as `0` and not read, and kept so shared links still read their share
  mode flag from the 9th (once called Isolate, hence the name). The shorter
  strings of older links, from before that flag (6 to 8 flags), are no longer
  read; such a link opens with the layers of a first visit. The slots and
  parameters of every toggle are listed in `flown/frontend/state/toggles.ts`
  - Example: `?v=100100000`
- Map position (`?lat=51.5&lng=13.4&z=10`). A centre without `z` opens at
  zoom 10. `z` counts in 256 pixel tiles, as links always did, which is one more
  than MapLibre's own zoom for the same view; links shared before the switch to
  MapLibre therefore still show the same area
- Orientation (`?b=-40.5&t=35`): `b` is the bearing, the degrees the top of the
  map is turned clockwise from north (any number, wrapped into -180 to 180), and
  `t` the tilt in degrees (held between 0 and 85). Both are written to a tenth
  of a degree and left out while the map is north up and flat
- Globe (`?g=1`), left out for Mercator. A link without `b`, `t` and `g`, which
  is every link from before the map could turn, opens north up, flat and in
  Mercator
- 3D view (`?d=1`), left out while the flights are drawn flat
- Satellite imagery (`?s=1`), left out while the ground is the dark map. It is a
  parameter of its own, like `g` and `d`, so the nine flags of `v` and every
  older link stay as they were
- The Flights tab of the statistics panel (`?l=1`), left out while the panel
  shows its figures
- The intro of the shared flights (`&i=1`), which Copy link adds to a link in
  share mode. The page takes it off the address bar as it opens, so the intro
  plays once, and nothing writes it back
- Debug logging in the browser console (`?debug=true`)
- The line of the cross-section (`?x=51.55,11.9,51.6,12.3`), the latitude and
  longitude of its start and then of its end, left out while the tool is closed;
  a link with it opens the tool on that line
- The heat counted by distance (`?r=1`) and the heat cloud's band of heights
  (`?h=500-3000`) are gone; an old link's `r` and `h` are ignored

Example URLs:

```text
?y=all                                   # Show all years
?y=2025&v=010000000                      # 2025 with the altitude layer only
?y=2025&a=D-EAGJ&lat=51.5&lng=13.4&z=10  # Complete state
?y=all&lat=48&lng=8&z=4&g=1&b=-30&t=50   # All years on a turned, tilted globe
?y=2025&z=9&t=60&d=1                     # 2025 in 3D
```

URL parameters take precedence over localStorage, allowing shared links to
override saved preferences.

### Shared links

Copy link packs everything the address bar link carries into one parameter,
`?c=<token>`, and the page turns it back into the ordinary link as it opens, so
the address bar of the visitor shows the readable link again. A view takes about
20 characters instead of 50 to 80, and the selected flights about half of what
they take in `p`:

```text
?y=2025&a=D-EAGJ&p=6jkc3usv%2Capxuod8z%2Ce13wu1of&sv=4&v=100100001&lat=51.123456&lng=13.654321&z=9.50&t=50&d=1&i=1
?c=BAv_-qT9IwcggAxMhhpX4BcV3GLtn0md2Ouyq9MNqmgY_jLTynW
```

The token is a stream of bits written six to a URL-safe base64 character
(`A`-`Z`, `a`-`z`, `0`-`9`, `-`, `_`), laid out in
`flown/frontend/state/shareToken.ts`: a format version, a check of the rest (its
length and a hash), a bit for each value saying whether the link has it, the
switches written as `1`, and then each value at exactly the precision the link
writes it in (the centre to six decimals, the zoom to two, bearing and tilt to a
tenth of a degree, a registration at six bits a character). The selected flights
come last: their ids sorted, and the gaps between them Rice-coded, about 6
characters a flight for a hundred flights instead of the 11 of an id in `p` and
its `%2C`. `debug` is left out. A link with a value the token has no room for is
copied as the long link instead. A token that does not resolve, as when a chat
or mail client cut it short, says so and opens the page as a first visit would,
not on the view the visitor saved last, which would pass for what was shared.
Tokens of the first format, which had no check, still resolve.

## Smart features

- **Mid-flight detection** - A recording started in the air adds no departure
  airport, and an arrival is only added where the track ends in a landing
- **Airport deduplication** - Merges the entries of one ICAO code, and names
  without a code that lie within 1.5 km of a marker; two different ICAO codes
  stay separate however close they are. A code known to OurAirports places the
  marker at the airport's own coordinates, so every flight to it lands on the
  same marker
- **Airport names** - Standardized from the ICAO code ("EDDS Stuttgart"); a
  single-word name without a code is not shown or counted as an airport
- **Parallel processing** - Fast parsing and export of multiple files
- **State persistence** - Saves to localStorage and syncs with URL for shareable
  links
- **Year-based organization** - Extracts and organizes flights by year
- **Per-aircraft statistics** - Tracks flight time and distance per aircraft
  registration
- **Aircraft model lookup** - Resolves full aircraft model names from
  `aircraft.json`
