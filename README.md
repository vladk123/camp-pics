# campsite-photos

## UPDATE - Nov 26, 2025
If a park has only campsites without campgrounds, give it a campground of "main" or something. The code is not currently fixed to work without campgrounds.

## Importing Seeds
Place the following .csv files in the root project folder, in a "data" folder.

**parks.csv** headers: 
- park_code	(BRUCEPEN)
    - =LEFT(TEXTJOIN("",TRUE,IF(ISERR(FIND(MID(UPPER(B3),ROW(INDIRECT("1:"&LEN(B3))),1),"ABCDEFGHIJKLMNOPQRSTUVWXYZ")), "", MID(UPPER(B3),ROW(INDIRECT("1:"&LEN(B3))),1))),8)
- name (Bruce Peninsula)
- type (*national* or *provincial* or *territorial*)
- province (Ontario)
- region ()
- lat (45.2200601682148)
- lng (-81.5307717179147)
- description
- campsiteCount	
- sites_ranges (1 - 45, if park doesn't have campgrounds, but only campsites)

**campgrounds.csv** headers:
- cg_code (CAMPGROUNDA-AARON)
    - =(CONCAT(LEFT(TEXTJOIN("",TRUE,IF(ISERR(FIND(MID(UPPER(B2),ROW(INDIRECT("1:"&LEN(B2))),1),"ABCDEFGHIJKLMNOPQRSTUVWXYZ")),"",MID(UPPER(B2),ROW(INDIRECT("1:"&LEN(B2))),1))),20),"-",C2))
- name (Campground A)
- park_code	(BRUCEPEN)
- sites_ranges (string, ex. 1 - 38, 94, 101)

**campsites.csv** headers:
- site_code	(1-CAMPGROUNDA-AARON)
    - (=CONCAT([@siteNumber],"-",[@[cg_code]]))
- cg_code (CAMPGROUNDA-AARON)
- park_code	(only if the campsite is directly in the park, without campgrounds)
- siteNumber (42)
- type (frontcountry, walk-in, or backcountry)
